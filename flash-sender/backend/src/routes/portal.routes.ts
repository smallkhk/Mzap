import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db';
import { requirePortalClient } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { writeLimiter } from '../middleware/rateLimit';
import { portalCreateAssetSchema, setSpendingLimitSchema } from '../schemas';
import { badRequest, conflict } from '../lib/errors';
import { recordAudit } from '../services/audit';
import { bumpConfigVersion } from '../services/configVersion';
import { serializeAsset, serializeNetwork } from '../services/serialize';
import * as serverWallet from '../services/serverWallet';
import { listLimitsFor, revokeLimitFor, setLimitFor } from '../services/spendingLimits';

/**
 * Self-service panel for a single API client.
 *
 * Every route here is scoped to `req.client` — the one key that
 * authenticated the request — and there is deliberately no route in this
 * file that can read or touch a *different* client. That is not a
 * permission check that could be gotten wrong; it is an absence. This
 * router has no `GET /clients`, no `POST /clients`, and no endpoint that
 * accepts a client id from the caller. What a portal session can do:
 *
 *   - see its own name, key prefix and status (never the key itself, and
 *     never another client's)
 *   - add a token to the shared catalog (the catalog is shared
 *     infrastructure; sending access to it is not — see the note on
 *     spending limits below)
 *   - read, grant, edit and revoke its *own* spending limits
 *
 * What it can never do, by construction rather than by role check:
 *
 *   - mint a new API key
 *   - see any other client's key, name, or limits
 *   - touch a network, or any admin-only setting
 *
 * A portal-enabled key can grant itself sending access, up to any amount,
 * for any asset in the catalog (including ones it just added). That is the
 * deliberate tradeoff of self-service: the admin's control is not "approve
 * every limit" but "decide which keys get this panel at all", via
 * `PATCH /api/admin/clients/:id/portal`. Revoking that flag — or the key
 * itself — removes every ability granted here immediately, because every
 * route re-checks `portalEnabled` and `isActive` on every request.
 */
export const portalRouter = Router();

portalRouter.use(requirePortalClient);

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/**
 * GET /api/portal/me
 *
 * Deliberately thin: enough to render "you are signed in as X", never a key
 * value (the client already holds its own key — that is how it authenticated
 * — and this never echoes it back) and nothing about any other client.
 */
portalRouter.get('/me', (req, res) => {
  const client = req.client!;
  res.json({
    name: client.name,
    keyPrefix: client.keyPrefix,
    isActive: client.isActive,
    lastSeenAt: client.lastSeenAt?.toISOString() ?? null,
    createdAt: client.createdAt.toISOString(),
    custodial: serverWallet.isCustodial(),
    address: serverWallet.isCustodial() ? serverWallet.address() : null,
  });
});

// ---------------------------------------------------------------------------
// Catalog (read-only networks, read + add for assets)
// ---------------------------------------------------------------------------

/** Only enabled networks — a customer adds a token to a live network, never a retired one. */
portalRouter.get('/networks', async (_req, res, next) => {
  try {
    const networks = await prisma.network.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ networks: networks.map(serializeNetwork) });
  } catch (err) {
    next(err);
  }
});

/** The full catalog, so a portal client can see what already exists before adding a limit or a duplicate token. */
portalRouter.get('/assets', async (_req, res, next) => {
  try {
    const assets = await prisma.asset.findMany({
      include: { network: true },
      orderBy: [{ sortOrder: 'asc' }, { symbol: 'asc' }],
    });
    res.json({ assets: assets.map(serializeAsset) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/portal/assets
 *
 * Adds a token to the shared catalog. This alone grants nobody the ability
 * to send it — including the client that added it — because sending is
 * still gated by a spending limit (see below). `isNative` is never accepted
 * from this schema: a portal client can add token contracts, never a
 * chain's native coin.
 */
portalRouter.post(
  '/assets',
  writeLimiter,
  validate(portalCreateAssetSchema),
  async (req, res, next) => {
    try {
      const { networkKey, ...rest } = req.body as any;

      const network = await prisma.network.findUnique({ where: { key: networkKey } });
      if (!network || !network.enabled) {
        return next(
          badRequest(
            'UNKNOWN_NETWORK',
            `No active network is configured with the key "${networkKey}".`,
          ),
        );
      }

      const created = await prisma.asset.create({
        data: { ...rest, isNative: false, enabled: true, networkId: network.id },
        include: { network: true },
      });

      const version = await bumpConfigVersion();

      await recordAudit({
        actorType: 'client',
        action: 'asset.create',
        entity: 'Asset',
        entityId: created.id,
        after: {
          assetId: created.assetId,
          symbol: created.symbol,
          chainId: network.chainId,
          contractAddress: created.contractAddress,
          decimals: created.decimals,
        },
        req,
      });

      return res.status(201).json({ asset: serializeAsset(created), configVersion: version });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return next(
          conflict(
            'DUPLICATE_ASSET',
            'An asset with that identifier, or that contract address on that network, already exists.',
          ),
        );
      }
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// This client's own spending limits
// ---------------------------------------------------------------------------

portalRouter.get('/limits', async (req, res, next) => {
  try {
    res.json({ limits: await listLimitsFor(req.client!.id) });
  } catch (err) {
    next(err);
  }
});

portalRouter.put('/limits', writeLimiter, validate(setSpendingLimitSchema), async (req, res, next) => {
  try {
    const client = req.client!;
    const limit = await setLimitFor(client.id, client.name, req.body, 'client', req);
    return res.json({ limit });
  } catch (err) {
    return next(err);
  }
});

portalRouter.delete('/limits/:assetId', writeLimiter, async (req, res, next) => {
  try {
    await revokeLimitFor(req.client!.id, req.params.assetId, 'client', req);
    return res.json({ revoked: true });
  } catch (err) {
    return next(err);
  }
});

