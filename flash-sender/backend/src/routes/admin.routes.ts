import { Router } from 'express';
import { AdminRole, Prisma } from '@prisma/client';
import { prisma } from '../lib/db';
import { config } from '../config';
import { requireAdmin, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { writeLimiter } from '../middleware/rateLimit';
import {
  buyExecuteSchema,
  buyQuoteSchema,
  createApiClientSchema,
  createAssetSchema,
  createNetworkSchema,
  setBuySettingsSchema,
  setClientPortalSchema,
  setSpendingLimitSchema,
  updateAssetSchema,
  updateNetworkSchema,
} from '../schemas';
import * as serverWallet from '../services/serverWallet';
import * as appSettings from '../services/appSettings';
import * as buyService from '../services/buyService';
import { badRequest, conflict, notFound } from '../lib/errors';
import { recordAudit } from '../services/audit';
import { listLimitsFor, revokeLimitFor, setLimitFor } from '../services/spendingLimits';
import { bumpConfigVersion, getConfigVersion } from '../services/configVersion';
import { serializeAsset, serializeNetwork } from '../services/serialize';
import { generateApiKey } from '../lib/crypto';
import { encodeUrlList } from '../lib/columns';

/**
 * Splits the validated `rpcUrls` array off the request body and returns it in
 * the storage shape. The API keeps taking and returning an array; only the
 * column underneath is text.
 */
function toNetworkData(body: Record<string, unknown> & { rpcUrls?: string[] }) {
  const { rpcUrls, ...rest } = body;
  return rpcUrls === undefined ? rest : { ...rest, rpcUrlsRaw: encodeUrlList(rpcUrls) };
}

export const adminRouter = Router();

adminRouter.use(requireAdmin);

const canWrite = requireRole(AdminRole.ADMIN);

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

adminRouter.get('/networks', async (_req, res, next) => {
  try {
    const networks = await prisma.network.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { assets: true } } },
    });
    res.json({
      networks: networks.map((n) => ({ ...serializeNetwork(n), assetCount: n._count.assets })),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  '/networks',
  canWrite,
  writeLimiter,
  validate(createNetworkSchema),
  async (req, res, next) => {
    try {
      const body = req.body as any;

      if (config.TESTNET_ONLY && !body.isTestnet) {
        return next(
          badRequest(
            'TESTNET_ONLY',
            'This deployment is configured for testnets only (TESTNET_ONLY=true). ' +
              'A mainnet network cannot be added here.',
          ),
        );
      }

      const created = await prisma.network.create({
        data: toNetworkData(body) as Prisma.NetworkUncheckedCreateInput,
      });
      const version = await bumpConfigVersion();

      await recordAudit({
        actorType: 'admin',
        action: 'network.create',
        entity: 'Network',
        entityId: created.id,
        after: created,
        req,
      });

      return res.status(201).json({ network: serializeNetwork(created), configVersion: version });
    } catch (err) {
      return next(err);
    }
  },
);

adminRouter.put(
  '/networks/:key',
  canWrite,
  writeLimiter,
  validate(updateNetworkSchema),
  async (req, res, next) => {
    try {
      const before = await prisma.network.findUnique({ where: { key: req.params.key } });
      if (!before) return next(notFound('Network'));

      const body = req.body as any;
      if (config.TESTNET_ONLY && body.isTestnet === false) {
        return next(
          badRequest(
            'TESTNET_ONLY',
            'This deployment is configured for testnets only and cannot host a mainnet network.',
          ),
        );
      }

      const updated = await prisma.network.update({
        where: { key: req.params.key },
        data: toNetworkData(body) as Prisma.NetworkUncheckedUpdateInput,
      });
      const version = await bumpConfigVersion();

      await recordAudit({
        actorType: 'admin',
        action: 'network.update',
        entity: 'Network',
        entityId: updated.id,
        before,
        after: updated,
        req,
      });

      return res.json({ network: serializeNetwork(updated), configVersion: version });
    } catch (err) {
      return next(err);
    }
  },
);

adminRouter.delete('/networks/:key', canWrite, writeLimiter, async (req, res, next) => {
  try {
    const network = await prisma.network.findUnique({
      where: { key: req.params.key },
      include: { _count: { select: { assets: true } } },
    });
    if (!network) return next(notFound('Network'));

    if (network._count.assets > 0) {
      return next(
        conflict(
          'NETWORK_IN_USE',
          `${network.name} still has ${network._count.assets} asset(s) configured. Remove or ` +
            'reassign them first, or disable the network instead of deleting it.',
        ),
      );
    }

    await prisma.network.delete({ where: { key: req.params.key } });
    const version = await bumpConfigVersion();

    await recordAudit({
      actorType: 'admin',
      action: 'network.delete',
      entity: 'Network',
      entityId: network.id,
      before: network,
      req,
    });

    return res.json({ deleted: true, configVersion: version });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

// Every route below only ever touches `clientId: null` rows — the shared,
// admin-curated catalog. A client's private asset (see config.routes.ts) is
// never listed, read, edited, toggled or deleted here, no matter its id;
// that boundary is enforced by this `where` clause, not just by what the
// dashboard's own UI happens to show.

adminRouter.get('/assets', async (_req, res, next) => {
  try {
    const assets = await prisma.asset.findMany({
      where: { clientId: null },
      include: { network: true },
      orderBy: [{ sortOrder: 'asc' }, { symbol: 'asc' }],
    });
    res.json({ version: await getConfigVersion(), assets: assets.map(serializeAsset) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/assets/:assetId', async (req, res, next) => {
  try {
    const asset = await prisma.asset.findFirst({
      where: { assetId: req.params.assetId, clientId: null },
      include: { network: true },
    });
    if (!asset) return next(notFound('Asset'));
    return res.json({ asset: serializeAsset(asset) });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/admin/assets
 *
 * The write path that makes a new token sendable. Once this returns, the
 * config version has moved and every desktop client picks the token up on its
 * next sync — no rebuild, no reinstall.
 */
adminRouter.post(
  '/assets',
  canWrite,
  writeLimiter,
  validate(createAssetSchema),
  async (req, res, next) => {
    try {
      const { networkKey, ...rest } = req.body as any;

      const network = await prisma.network.findUnique({ where: { key: networkKey } });
      if (!network) {
        return next(
          badRequest(
            'UNKNOWN_NETWORK',
            `No network is configured with the key "${networkKey}". Create the network first.`,
          ),
        );
      }

      if (rest.isNative) {
        const existingNative = await prisma.asset.findFirst({
          where: { networkId: network.id, isNative: true },
        });
        if (existingNative) {
          return next(
            conflict(
              'NATIVE_ALREADY_DEFINED',
              `${network.name} already has a native coin configured (${existingNative.symbol}). ` +
                'A network can only have one native asset.',
            ),
          );
        }
        if (rest.decimals !== network.nativeDecimals) {
          return next(
            badRequest(
              'NATIVE_DECIMALS_MISMATCH',
              `The native coin of ${network.name} uses ${network.nativeDecimals} decimals.`,
            ),
          );
        }
      }

      const created = await prisma.asset.create({
        data: {
          ...rest,
          contractAddress: rest.isNative ? null : rest.contractAddress,
          networkId: network.id,
        },
        include: { network: true },
      });

      const version = await bumpConfigVersion();

      await recordAudit({
        actorType: 'admin',
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

adminRouter.put(
  '/assets/:assetId',
  canWrite,
  writeLimiter,
  validate(updateAssetSchema),
  async (req, res, next) => {
    try {
      const before = await prisma.asset.findFirst({
        where: { assetId: req.params.assetId, clientId: null },
        include: { network: true },
      });
      if (!before) return next(notFound('Asset'));

      const { networkKey, ...rest } = req.body as any;
      let networkId = before.networkId;

      if (networkKey && networkKey !== before.network.key) {
        const network = await prisma.network.findUnique({ where: { key: networkKey } });
        if (!network) {
          return next(badRequest('UNKNOWN_NETWORK', `No network with key "${networkKey}".`));
        }
        networkId = network.id;
      }

      const isNative = rest.isNative ?? before.isNative;

      const updated = await prisma.asset.update({
        where: { assetId: req.params.assetId },
        data: {
          ...rest,
          networkId,
          contractAddress: isNative ? null : (rest.contractAddress ?? before.contractAddress),
        },
        include: { network: true },
      });

      const version = await bumpConfigVersion();

      await recordAudit({
        actorType: 'admin',
        action: 'asset.update',
        entity: 'Asset',
        entityId: updated.id,
        before: {
          contractAddress: before.contractAddress,
          decimals: before.decimals,
          symbol: before.symbol,
          enabled: before.enabled,
        },
        after: {
          contractAddress: updated.contractAddress,
          decimals: updated.decimals,
          symbol: updated.symbol,
          enabled: updated.enabled,
        },
        req,
      });

      return res.json({ asset: serializeAsset(updated), configVersion: version });
    } catch (err) {
      return next(err);
    }
  },
);

/** Convenience toggle used by the switch in the dashboard table. */
adminRouter.post('/assets/:assetId/toggle', canWrite, writeLimiter, async (req, res, next) => {
  try {
    const before = await prisma.asset.findFirst({ where: { assetId: req.params.assetId, clientId: null } });
    if (!before) return next(notFound('Asset'));

    const updated = await prisma.asset.update({
      where: { assetId: req.params.assetId },
      data: { enabled: !before.enabled },
      include: { network: true },
    });
    const version = await bumpConfigVersion();

    await recordAudit({
      actorType: 'admin',
      action: updated.enabled ? 'asset.enable' : 'asset.disable',
      entity: 'Asset',
      entityId: updated.id,
      before: { enabled: before.enabled },
      after: { enabled: updated.enabled },
      req,
    });

    return res.json({ asset: serializeAsset(updated), configVersion: version });
  } catch (err) {
    return next(err);
  }
});

adminRouter.delete('/assets/:assetId', canWrite, writeLimiter, async (req, res, next) => {
  try {
    const before = await prisma.asset.findFirst({ where: { assetId: req.params.assetId, clientId: null } });
    if (!before) return next(notFound('Asset'));

    await prisma.asset.delete({ where: { assetId: req.params.assetId } });
    const version = await bumpConfigVersion();

    await recordAudit({
      actorType: 'admin',
      action: 'asset.delete',
      entity: 'Asset',
      entityId: before.id,
      before,
      req,
    });

    return res.json({ deleted: true, configVersion: version });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// API clients (desktop installations)
// ---------------------------------------------------------------------------

adminRouter.get('/clients', async (_req, res, next) => {
  try {
    const clients = await prisma.apiClient.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        keyPrefix: c.keyPrefix,
        isActive: c.isActive,
        portalEnabled: c.portalEnabled,
        lastSeenAt: c.lastSeenAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** The plaintext key is returned exactly once, here. */
adminRouter.post(
  '/clients',
  canWrite,
  writeLimiter,
  validate(createApiClientSchema),
  async (req, res, next) => {
    try {
      const { name } = req.body as { name: string };
      const { key, hash, prefix } = generateApiKey();

      const client = await prisma.apiClient.create({
        data: { name, keyHash: hash, keyPrefix: prefix },
      });

      await recordAudit({
        actorType: 'admin',
        action: 'client.create',
        entity: 'ApiClient',
        entityId: client.id,
        after: { name, keyPrefix: prefix },
        req,
      });

      return res.status(201).json({
        client: { id: client.id, name: client.name, keyPrefix: prefix },
        apiKey: key,
        notice:
          'Copy this API key now — it is stored only as a hash and cannot be shown again.',
      });
    } catch (err) {
      return next(err);
    }
  },
);

adminRouter.post('/clients/:id/revoke', canWrite, writeLimiter, async (req, res, next) => {
  try {
    const client = await prisma.apiClient.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    await recordAudit({
      actorType: 'admin',
      action: 'client.revoke',
      entity: 'ApiClient',
      entityId: client.id,
      req,
    });

    return res.json({ revoked: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * PATCH /api/admin/clients/:id/portal
 *
 * Turns this one key's self-service panel on or off. It is the only thing
 * that ever grants portal access — creating a key does not, and the panel
 * itself has no route that could grant it to another key or to itself again
 * once revoked.
 */
adminRouter.patch(
  '/clients/:id/portal',
  canWrite,
  writeLimiter,
  validate(setClientPortalSchema),
  async (req, res, next) => {
    try {
      const { enabled } = req.body as { enabled: boolean };

      const client = await prisma.apiClient.update({
        where: { id: req.params.id },
        data: { portalEnabled: enabled },
      });

      await recordAudit({
        actorType: 'admin',
        action: enabled ? 'client.portal.enable' : 'client.portal.disable',
        entity: 'ApiClient',
        entityId: client.id,
        after: { portalEnabled: enabled },
        req,
      });

      return res.json({ portalEnabled: client.portalEnabled });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return next(notFound('API client'));
      }
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Custodial wallet + spending limits
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/wallet
 *
 * Whether this deployment signs on behalf of clients, and from which address.
 */
adminRouter.get('/wallet', (_req, res) => {
  res.json({
    custodial: serverWallet.isCustodial(),
    address: serverWallet.isCustodial() ? serverWallet.address() : null,
  });
});

// ---------------------------------------------------------------------------
// Buy settings (markup + profit address)
// ---------------------------------------------------------------------------

adminRouter.get('/buy/settings', async (_req, res, next) => {
  try {
    res.json(await appSettings.getBuySettings());
  } catch (err) {
    next(err);
  }
});

adminRouter.put(
  '/buy/settings',
  canWrite,
  writeLimiter,
  validate(setBuySettingsSchema),
  async (req, res, next) => {
    try {
      const before = await appSettings.getBuySettings();
      const after = await appSettings.setBuySettings(req.body);

      await recordAudit({
        actorType: 'admin',
        action: 'buySettings.update',
        entity: 'AppSetting',
        before,
        after,
        req,
      });

      res.json(after);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The admin's own buy tool. Spends the shared custodial wallet's own
 * funds — no markup, nothing to charge yourself. Requires custodial mode;
 * there is no other wallet for the admin dashboard to spend from.
 */
adminRouter.post(
  '/buy/quote',
  writeLimiter,
  validate(buyQuoteSchema),
  async (req, res, next) => {
    try {
      res.json(await buyService.prepareBuy({ kind: 'admin' }, req.body));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post(
  '/buy/execute',
  canWrite,
  writeLimiter,
  validate(buyExecuteSchema),
  async (req, res, next) => {
    try {
      const { quoteRef } = req.body as { quoteRef: string };
      res.status(201).json(await buyService.confirmBuy({ kind: 'admin' }, quoteRef));
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/admin/clients/:id/limits */
adminRouter.get('/clients/:id/limits', async (req, res, next) => {
  try {
    res.json({ limits: await listLimitsFor(req.params.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/clients/:id/limits
 *
 * Grants or updates one asset's cap for one installation. Because a client
 * with no limit row cannot send an asset at all, this is also how sending
 * access is granted in the first place.
 */
adminRouter.put(
  '/clients/:id/limits',
  canWrite,
  writeLimiter,
  validate(setSpendingLimitSchema),
  async (req, res, next) => {
    try {
      const client = await prisma.apiClient.findUnique({ where: { id: req.params.id } });
      if (!client) return next(notFound('API client'));

      const limit = await setLimitFor(client.id, client.name, req.body, 'admin', req);
      return res.json({ limit });
    } catch (err) {
      return next(err);
    }
  },
);

/** DELETE /api/admin/clients/:id/limits/:assetId — revokes access to that asset. */
adminRouter.delete('/clients/:id/limits/:assetId', canWrite, writeLimiter, async (req, res, next) => {
  try {
    await revokeLimitFor(req.params.id, req.params.assetId, 'admin', req);
    return res.json({ revoked: true });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Ledger + audit (read-only views for operators)
// ---------------------------------------------------------------------------

adminRouter.get('/transactions', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await prisma.transactionRecord.findMany({
      orderBy: { submittedAt: 'desc' },
      take: limit,
      include: { client: { select: { name: true } } },
    });
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/audit', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});
