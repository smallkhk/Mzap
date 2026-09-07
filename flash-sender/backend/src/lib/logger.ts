import pino from 'pino';
import { config } from '../config';

/**
 * Structured logger.
 *
 * `redact` is the last line of defence: even if a caller mistakenly logs a
 * request body, anything that looks like key material is stripped before it
 * reaches a log sink.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.privateKey',
      '*.mnemonic',
      '*.seedPhrase',
      '*.secret',
      '*.token',
      'body.password',
      'body.privateKey',
      'body.mnemonic',
    ],
    censor: '[redacted]',
  },
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
