import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { config } from './config';
import { logger } from './lib/logger';
import { apiLimiter } from './middleware/rateLimit';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { rejectKeyMaterial } from './middleware/validate';
import { authRouter } from './routes/auth.routes';
import { configRouter } from './routes/config.routes';
import { transactionsRouter } from './routes/transactions.routes';
import { adminRouter } from './routes/admin.routes';
import { getConfigVersion } from './services/configVersion';

export function createApp() {
  const app = express();

  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: config.REQUIRE_HTTPS
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  /**
   * HTTPS enforcement. The desktop client also refuses to talk to a non-https
   * base URL unless it is loopback, so this is defence in depth rather than
   * the only guard.
   */
  if (config.REQUIRE_HTTPS) {
    app.use((req, res, next) => {
      const proto = req.header('x-forwarded-proto') ?? req.protocol;
      if (proto !== 'https') {
        return res.status(426).json({
          error: {
            code: 'HTTPS_REQUIRED',
            message: 'This API only accepts requests over HTTPS.',
          },
        });
      }
      return next();
    });
  }

  app.use(
    cors({
      origin(origin, callback) {
        // Desktop clients send no Origin header; browsers must be allow-listed.
        if (!origin || config.adminOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not permitted to call this API.`));
      },
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(rejectKeyMaterial);

  app.get('/health', async (_req, res) => {
    try {
      res.json({
        status: 'ok',
        version: await getConfigVersion(),
        testnetOnly: config.TESTNET_ONLY,
        time: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({ status: 'degraded', message: 'Database is not reachable.' });
    }
  });

  app.use('/api', apiLimiter);
  app.use('/api/auth', authRouter);
  app.use('/api', configRouter);
  app.use('/api', transactionsRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
