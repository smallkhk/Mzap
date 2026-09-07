import { Router } from 'express';
import { addDays } from '../lib/time';
import { prisma } from '../lib/db';
import { config } from '../config';
import {
  generateRefreshToken,
  sha256,
  signAccessToken,
  verifyPassword,
} from '../lib/crypto';
import { loginSchema, refreshSchema } from '../schemas';
import { validate } from '../middleware/validate';
import { authLimiter } from '../middleware/rateLimit';
import { requireAdmin } from '../middleware/auth';
import { unauthorized } from '../lib/errors';
import { recordAudit } from '../services/audit';
import crypto from 'node:crypto';

export const authRouter = Router();

/**
 * POST /api/auth/login
 *
 * Failure responses are deliberately identical for "no such user", "wrong
 * password" and "inactive account" so the endpoint cannot be used to
 * enumerate administrator accounts.
 */
authRouter.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body as { email: string; password: string };
    const user = await prisma.adminUser.findUnique({ where: { email } });

    const ok = user?.isActive ? await verifyPassword(user.passwordHash, password) : false;

    if (!ok || !user) {
      // Spend comparable time on the miss path to blunt timing analysis.
      if (!user) await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaA', password);
      await recordAudit({ actorType: 'admin', action: 'auth.login.failed', req, after: { email } });
      return next(unauthorized('Incorrect email address or password.'));
    }

    const familyId = crypto.randomUUID();
    const { token: refreshToken, hash } = generateRefreshToken();

    await prisma.$transaction([
      prisma.refreshToken.create({
        data: {
          tokenHash: hash,
          familyId,
          userId: user.id,
          expiresAt: addDays(new Date(), config.REFRESH_TOKEN_TTL_DAYS),
        },
      }),
      prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    ]);

    await recordAudit({
      actorType: 'admin',
      action: 'auth.login.succeeded',
      entity: 'AdminUser',
      entityId: user.id,
      req,
    });

    return res.json({
      accessToken: signAccessToken({ sub: user.id, email: user.email, role: user.role }),
      refreshToken,
      expiresIn: config.ACCESS_TOKEN_TTL,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/auth/refresh
 *
 * Refresh tokens are single-use and rotate. Presenting one that has already
 * been used means it leaked, so the entire token family is revoked and the
 * operator must sign in again.
 */
authRouter.post('/refresh', authLimiter, validate(refreshSchema), async (req, res, next) => {
  try {
    const { refreshToken } = req.body as { refreshToken: string };
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      include: { user: true },
    });

    if (!stored) return next(unauthorized('That session token is not valid. Sign in again.'));

    if (stored.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await recordAudit({
        actorType: 'admin',
        action: 'auth.refresh.reuse_detected',
        entity: 'AdminUser',
        entityId: stored.userId,
        req,
      });
      return next(
        unauthorized('This session token has already been used. All sessions have been signed out.'),
      );
    }

    if (stored.expiresAt < new Date() || !stored.user.isActive) {
      return next(unauthorized('Your session has expired. Sign in again.'));
    }

    const { token: nextToken, hash } = generateRefreshToken();

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          tokenHash: hash,
          familyId: stored.familyId,
          userId: stored.userId,
          expiresAt: addDays(new Date(), config.REFRESH_TOKEN_TTL_DAYS),
        },
      }),
    ]);

    return res.json({
      accessToken: signAccessToken({
        sub: stored.user.id,
        email: stored.user.email,
        role: stored.user.role,
      }),
      refreshToken: nextToken,
      expiresIn: config.ACCESS_TOKEN_TTL,
      user: { id: stored.user.id, email: stored.user.email, role: stored.user.role },
    });
  } catch (err) {
    return next(err);
  }
});

/** POST /api/auth/logout — revokes the presented refresh token's family. */
authRouter.post('/logout', validate(refreshSchema), async (req, res, next) => {
  try {
    const { refreshToken } = req.body as { refreshToken: string };
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
    });

    if (stored) {
      await prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

/** GET /api/auth/me */
authRouter.get('/me', requireAdmin, (req, res) => {
  res.json({ user: req.admin });
});
