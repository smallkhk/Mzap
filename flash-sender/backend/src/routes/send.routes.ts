import { Router } from 'express';
import { z } from 'zod';
import { requireClient } from '../middleware/auth';
import { validate, rejectKeyMaterial } from '../middleware/validate';
import { writeLimiter } from '../middleware/rateLimit';
import { addressSchema, slugSchema } from '../schemas';
import * as sendService from '../services/sendService';
import * as wallet from '../services/serverWallet';
import * as chain from '../services/chainService';
import { prisma } from '../lib/db';
import { formatAmount } from '../lib/amount';
import { AppError } from '../lib/errors';

export const sendRouter = Router();

const prepareSchema = z.object({
  assetId: slugSchema,
  recipient: addressSchema,
  amount: z.string().min(1).max(80),
});

const confirmSchema = z.object({
  clientRef: z.string().uuid(),
});

/**
 * GET /api/wallet
 *
 * The sending wallet's address and, for the requested asset, its live
 * balances. Returns `custodial: false` when this deployment has no server
 * wallet, which is how the desktop client decides whether to ask the user to
 * import a key of their own.
 */
sendRouter.get('/wallet', requireClient, async (req, res, next) => {
  try {
    if (!wallet.isCustodial()) {
      return res.json({ custodial: false, address: null });
    }

    const address = wallet.address();
    const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : undefined;

    if (!assetId) {
      return res.json({ custodial: true, address, asset: null, native: null });
    }

    const asset = await prisma.asset.findUnique({
      where: { assetId },
      include: { network: true },
    });

    if (!asset) {
      return res.json({ custodial: true, address, asset: null, native: null });
    }

    const [assetBalance, nativeBalance] = await Promise.all([
      chain.getBalanceFor(asset, address),
      chain.getNativeBalance(asset.network, address),
    ]);

    // What this installation is still allowed to send today, so the app can
    // show the real ceiling rather than only the wallet balance.
    const limit = await prisma.spendingLimit.findUnique({
      where: { clientId_assetId: { clientId: req.client!.id, assetId } },
    });

    return res.json({
      custodial: true,
      address,
      asset: {
        raw: assetBalance.toString(),
        formatted: formatAmount(assetBalance, asset.decimals),
        symbol: asset.symbol,
        decimals: asset.decimals,
      },
      native: {
        raw: nativeBalance.toString(),
        formatted: formatAmount(nativeBalance, asset.network.nativeDecimals),
        symbol: asset.network.nativeSymbol,
        decimals: asset.network.nativeDecimals,
      },
      limit:
        limit && limit.enabled
          ? {
              maxPerTx: formatAmount(limit.maxPerTxRaw, asset.decimals),
              maxPerDay: formatAmount(limit.maxPerDayRaw, asset.decimals),
            }
          : null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/send/prepare
 *
 * Validates and quotes. Nothing is signed. The quote is held server-side and
 * referenced by `clientRef`, so confirming cannot alter the amount or
 * recipient that was displayed.
 */
sendRouter.post(
  '/send/prepare',
  requireClient,
  writeLimiter,
  rejectKeyMaterial,
  validate(prepareSchema),
  async (req, res, next) => {
    try {
      res.json(await sendService.prepare(req.client!, req.body as sendService.PrepareInput));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/send/confirm
 *
 * Signs with the server wallet and broadcasts. Returns the hash the node
 * produced — never a generated one.
 */
sendRouter.post(
  '/send/confirm',
  requireClient,
  writeLimiter,
  validate(confirmSchema),
  async (req, res, next) => {
    try {
      const { clientRef } = req.body as { clientRef: string };
      res.status(201).json(await sendService.confirm(req.client!, clientRef));
    } catch (err) {
      next(err);
    }
  },
);

/** Guard: this router is meaningless without a server wallet. */
sendRouter.use((_req, _res, next) => {
  if (!wallet.isCustodial()) {
    return next(
      new AppError(503, 'NO_SERVER_WALLET', 'This deployment has no server wallet configured.'),
    );
  }
  return next();
});
