import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db';
import { config } from '../config';
import { requireClient } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { writeLimiter } from '../middleware/rateLimit';
import { assetQuerySchema, clientCreateAssetSchema, clientUpdateAssetSchema } from '../schemas';
import { badRequest, conflict, notFound } from '../lib/errors';
import { getConfigVersion } from '../services/configVersion';
import { serializeAsset, serializeNetwork } from '../services/serialize';
import { recordAudit } from '../services/audit';
import * as serverWallet from '../services/serverWallet';

export const configRouter = Router();

/** Adds `isMine`/`isPrivate` on top of the shared shape — meaningful only from a client's own point of view, never the admin dashboard's. */
function serializeClientAsset(asset: Parameters<typeof serializeAsset>[0] & { clientId: string | null }, clientId: string) {
  return {
    ...serializeAsset(asset),
    isPrivate: asset.clientId !== null,
    isMine: asset.clientId === clientId,
  };
}

// `requireClient` is attached to each route individually rather than with a
// blanket `router.use()`. These routers mount at the bare `/api` prefix, and a
// router-level guard there would also intercept `/api/admin/*` and
// `/api/auth/*`, rejecting administrators for want of a desktop API key.
// Per-route middleware keeps the boundary explicit and order-independent.

/**
 * GET /api/config/version
 *
 * Deliberately tiny: the desktop app polls this on an interval and only
 * re-fetches assets when the number moves.
 */
configRouter.get('/config/version', requireClient, async (_req, res, next) => {
  try {
    res.json({ version: await getConfigVersion() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/config
 *
 * One round trip for a cold start: version, networks and assets together.
 */
configRouter.get('/config', requireClient, async (req, res, next) => {
  try {
    const [version, networks, assets] = await Promise.all([
      getConfigVersion(),
      prisma.network.findMany({
        where: { enabled: true, ...(config.TESTNET_ONLY ? { isTestnet: true } : {}) },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      // The shared catalog, plus this one client's own private additions —
      // never another client's. A private asset is enabled unconditionally;
      // it was never subject to the admin's own enable/disable toggle.
      prisma.asset.findMany({
        where: {
          network: { enabled: true, ...(config.TESTNET_ONLY ? { isTestnet: true } : {}) },
          OR: [{ clientId: null, enabled: true }, { clientId: req.client!.id }],
        },
        include: { network: true },
        orderBy: [{ sortOrder: 'asc' }, { symbol: 'asc' }],
      }),
    ]);

    res.json({
      version,
      testnetOnly: config.TESTNET_ONLY,
      // "custodial" means this server holds the sending key and signs for
      // clients; the desktop app then skips its own wallet setup entirely.
      signingMode: serverWallet.isCustodial() ? 'custodial' : 'local',
      senderAddress: serverWallet.isCustodial() ? serverWallet.address() : null,
      networks: networks.map(serializeNetwork),
      assets: assets.map((a) => serializeClientAsset(a, req.client!.id)),
      /// Advisory only — the client enforces its own confirmation policy too.
      policy: {
        minConfirmations: 1,
        pendingWarningSeconds: 300,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/networks */
configRouter.get('/networks', requireClient, async (_req, res, next) => {
  try {
    const networks = await prisma.network.findMany({
      where: { enabled: true, ...(config.TESTNET_ONLY ? { isTestnet: true } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ networks: networks.map(serializeNetwork) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/assets?network=bsc
 *
 * The response is the complete definition of what the application may send.
 * Disabled assets and assets on disabled networks are omitted entirely, which
 * is how "disable this token" takes effect on clients without a rebuild.
 */
configRouter.get('/assets', requireClient, validate(assetQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { network } = req.query as unknown as { network?: string };

    // The shared catalog, plus this one client's own private additions.
    const assets = await prisma.asset.findMany({
      where: {
        network: {
          enabled: true,
          ...(network ? { key: network } : {}),
          ...(config.TESTNET_ONLY ? { isTestnet: true } : {}),
        },
        OR: [{ clientId: null, enabled: true }, { clientId: req.client!.id }],
      },
      include: { network: true },
      orderBy: [{ sortOrder: 'asc' }, { symbol: 'asc' }],
    });

    res.json({
      version: await getConfigVersion(),
      assets: assets.map((a) => serializeClientAsset(a, req.client!.id)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/assets
 *
 * Adds a token that's private to this API key alone — never surfaced to any
 * other client, and never shown in the admin dashboard's own Assets list.
 * Adding one alone grants no ability to send it: sending is still gated by
 * a spending limit, same as anything else in the catalog.
 */
configRouter.post(
  '/assets',
  requireClient,
  writeLimiter,
  validate(clientCreateAssetSchema),
  async (req, res, next) => {
    try {
      const { networkKey, ...rest } = req.body as {
        networkKey: string;
        assetId: string;
        name: string;
        symbol: string;
        contractAddress: string;
        decimals: number;
        explorerUrl?: string | null;
        logoUrl?: string | null;
      };

      const network = await prisma.network.findUnique({ where: { key: networkKey } });
      if (!network || !network.enabled) {
        return next(badRequest('UNKNOWN_NETWORK', `No active network is configured with the key "${networkKey}".`));
      }

      const created = await prisma.asset.create({
        data: {
          ...rest,
          isNative: false,
          enabled: true,
          networkId: network.id,
          clientId: req.client!.id,
          ownerScope: req.client!.id,
        },
        include: { network: true },
      });

      await recordAudit({
        actorType: 'client',
        action: 'asset.create.private',
        entity: 'Asset',
        entityId: created.id,
        after: {
          assetId: created.assetId,
          symbol: created.symbol,
          chainId: network.chainId,
          contractAddress: created.contractAddress,
          decimals: created.decimals,
          clientId: req.client!.id,
        },
        req,
      });

      return res.status(201).json({ asset: serializeClientAsset(created, req.client!.id) });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return next(conflict('ASSET_EXISTS', 'You already have a token with this contract address on this network.'));
      }
      next(err);
    }
  },
);

/**
 * PUT /api/assets/:assetId
 *
 * Edits one of THIS client's own private assets — never the shared catalog,
 * and never another client's. The network and contract address, what
 * actually identify a token on-chain, are fixed at creation; only the
 * label and whether it's currently offered can change here.
 */
configRouter.put(
  '/assets/:assetId',
  requireClient,
  writeLimiter,
  validate(clientUpdateAssetSchema),
  async (req, res, next) => {
    try {
      const existing = await prisma.asset.findUnique({ where: { assetId: req.params.assetId } });
      if (!existing || existing.clientId !== req.client!.id) {
        return next(notFound('Asset'));
      }

      const updated = await prisma.asset.update({
        where: { id: existing.id },
        data: req.body as Record<string, unknown>,
        include: { network: true },
      });

      await recordAudit({
        actorType: 'client',
        action: 'asset.update.private',
        entity: 'Asset',
        entityId: updated.id,
        before: { name: existing.name, symbol: existing.symbol, enabled: existing.enabled },
        after: { name: updated.name, symbol: updated.symbol, enabled: updated.enabled },
        req,
      });

      res.json({ asset: serializeClientAsset(updated, req.client!.id) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/assets/:assetId
 *
 * Removes one of this client's own private assets. The shared catalog is
 * untouched by this route no matter what id is given — deleting an asset
 * the admin added requires the admin dashboard.
 */
configRouter.delete('/assets/:assetId', requireClient, writeLimiter, async (req, res, next) => {
  try {
    const existing = await prisma.asset.findUnique({ where: { assetId: req.params.assetId } });
    if (!existing || existing.clientId !== req.client!.id) {
      return next(notFound('Asset'));
    }

    await prisma.asset.delete({ where: { id: existing.id } });

    await recordAudit({
      actorType: 'client',
      action: 'asset.delete.private',
      entity: 'Asset',
      entityId: existing.id,
      before: { assetId: existing.assetId, symbol: existing.symbol },
      req,
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
