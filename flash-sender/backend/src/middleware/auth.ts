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
 * Looks a raw `X-API-Key` value up to an active client, or throws the same
 * error `requireClient` and `requirePortalClient` both need to report. Shared
 * so the two authentication paths — the desktop app's and the self-service
 * portal's — can never drift on what counts as a valid key.
 */
async function authenticateApiKey(key: string | undefined, req: Request): Promise<ApiClient> {
  if (!key) {
    throw unauthorized('Missing API key. Set the application API key in Settings before connecting.');
  }

  const client = await prisma.apiClient.findUnique({ where: { keyHash: sha256(key) } });

  if (!client || !client.isActive) {
    await recordAudit({
      actorType: 'client',
      action: 'auth.client.rejected',
      req,
      after: { keyPrefix: key.slice(0, 12) },
    });
    throw unauthorized('This API key is not recognised or has been revoked. Contact your administrator.');
  }

  // Best-effort liveness tracking; never block the request on it.
  void prisma.apiClient
    .update({ where: { id: client.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return client;
}

/**
 * Desktop-client authentication via `X-API-Key`.
 *
 * A client key grants read access to configuration and the ability to record
 * its own transactions. It grants nothing else — in particular it can never
 * change which contract addresses are considered legitimate.
 */
export async function requireClient(req: Request, _res: Response, next: NextFunction) {
  try {
    req.client = await authenticateApiKey(req.header('x-api-key'), req);
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * Self-service portal authentication via the same `X-API-Key` header.
 *
 * Guards everything under /api/portal. On top of a valid, active key, the
 * key must have been explicitly opted into the portal by an administrator
 * (`ApiClient.portalEnabled`) — issuing a key for the desktop app does not
 * by itself grant this second, web-facing surface. Every route behind this
 * middleware acts on `req.client` alone, so there is no request shape that
 * lets one portal session touch a different client's keys, limits or
 * assets.
 */
export async function requirePortalClient(req: Request, _res: Response, next: NextFunction) {
  try {
    const client = await authenticateApiKey(req.header('x-api-key'), req);

    if (!client.portalEnabled) {
      return next(
        forbidden(
          'This API key does not have portal access. Ask your administrator to enable it.',
        ),
      );
    }

    req.client = client;
    return next();
  } catch (err) {
    return next(err);
  }
}
