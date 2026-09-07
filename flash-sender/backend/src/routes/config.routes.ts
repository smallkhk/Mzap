import { Router } from 'express';
import { prisma } from '../lib/db';
import { config } from '../config';
import { requireClient } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { assetQuerySchema } from '../schemas';
import { getConfigVersion } from '../services/configVersion';
import { serializeAsset, serializeNetwork } from '../services/serialize';
import * as serverWallet from '../services/serverWallet';

export const configRouter = Router();

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
configRouter.get('/config', requireClient, async (_req, res, next) => {
  try {
    const [version, networks, assets] = await Promise.all([
      getConfigVersion(),
      prisma.network.findMany({
        where: { enabled: true, ...(config.TESTNET_ONLY ? { isTestnet: true } : {}) },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.asset.findMany({
        where: {
          enabled: true,
          network: { enabled: true, ...(config.TESTNET_ONLY ? { isTestnet: true } : {}) },
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
      assets: assets.map(serializeAsset),
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

    const assets = await prisma.asset.findMany({
      where: {
        enabled: true,
        network: {
          enabled: true,
          ...(network ? { key: network } : {}),
          ...(config.TESTNET_ONLY ? { isTestnet: true } : {}),
        },
      },
      include: { network: true },
      orderBy: [{ sortOrder: 'asc' }, { symbol: 'asc' }],
    });

    res.json({ version: await getConfigVersion(), assets: assets.map(serializeAsset) });
  } catch (err) {
    next(err);
  }
});
