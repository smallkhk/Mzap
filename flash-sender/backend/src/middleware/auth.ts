import type { NextFunction, Request, Response } from 'express';
import type { AdminRole, ApiClient } from '@prisma/client';
import { prisma } from '../lib/db';
import { sha256, verifyAccessToken } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';
import { recordAudit } from '../services/audit';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: { id: string; email: string; role: AdminRole };
      client?: ApiClient;
    }
  }
}

/**
 * Admin bearer-token authentication. Guards everything under /api/admin.
 */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');

  if (!header?.startsWith('Bearer ')) {
    return next(unauthorized('Sign in to the admin dashboard to continue.'));
  }

  try {
    const claims = verifyAccessToken(header.slice('Bearer '.length).trim());
    const user = await prisma.adminUser.findUnique({ where: { id: claims.sub } });

    if (!user || !user.isActive) {
      return next(unauthorized('This administrator account is no longer active.'));
    }

    req.admin = { id: user.id, email: user.email, role: user.role };
    return next();
  } catch (err) {
    const expired = err instanceof Error && err.name === 'TokenExpiredError';
    return next(
      unauthorized(
        expired
          ? 'Your session has expired. Sign in again to continue.'
          : 'Your session is not valid. Sign in again to continue.',
      ),
    );
  }
}

/** Requires the ADMIN role — VIEWER accounts get read-only access. */
export function requireRole(...roles: AdminRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) return next(unauthorized());
    if (!roles.includes(req.admin.role)) {
      return next(
        forbidden(
          `This action requires the ${roles.join(' or ')} role. Your account has the ${
            req.admin.role
          } role.`,
        ),
      );
    }
    return next();
  };
}

/**
 * Desktop-client authentication via `X-API-Key`.
 *
 * A client key grants read access to configuration and the ability to record
 * its own transactions. It grants nothing else — in particular it can never
 * change which contract addresses are considered legitimate.
 */
export async function requireClient(req: Request, _res: Response, next: NextFunction) {
  const key = req.header('x-api-key');

  if (!key) {
    return next(
      unauthorized(
        'Missing API key. Set the application API key in Settings before connecting.',
      ),
    );
  }

  const client = await prisma.apiClient.findUnique({ where: { keyHash: sha256(key) } });

  if (!client || !client.isActive) {
    await recordAudit({
      actorType: 'client',
      action: 'auth.client.rejected',
      req,
      after: { keyPrefix: key.slice(0, 12) },
    });
    return next(
      unauthorized('This API key is not recognised or has been revoked. Contact your administrator.'),
    );
  }

  req.client = client;

  // Best-effort liveness tracking; never block the request on it.
  void prisma.apiClient
    .update({ where: { id: client.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return next();
}
