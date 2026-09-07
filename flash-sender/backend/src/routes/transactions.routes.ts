import { Router } from 'express';
import { Prisma, TxStatus } from '@prisma/client';
import { prisma } from '../lib/db';
import { requireClient } from '../middleware/auth';
import { validate, rejectKeyMaterial } from '../middleware/validate';
import { writeLimiter } from '../middleware/rateLimit';
import {
  createTransactionSchema,
  transactionQuerySchema,
  updateTransactionSchema,
} from '../schemas';
import { badRequest, conflict, notFound } from '../lib/errors';
import { recordAudit } from '../services/audit';
import { serializeTransaction } from '../services/serialize';
import { canTransition, describeIllegalTransition } from '../services/txState';

export const transactionsRouter = Router();

// Attached per route, not router-wide: this router mounts at `/api`, so a
// blanket guard would also swallow `/api/admin/*` and `/api/auth/*`.

/** Resolves the explorer base for a record so links can be built server-side. */
async function explorerFor(chainId: number, assetId: string): Promise<string | null> {
  const asset = await prisma.asset.findUnique({
    where: { assetId },
    include: { network: true },
  });
  if (asset && asset.network.chainId === chainId) {
    return asset.explorerUrl ?? asset.network.explorerUrl;
  }
  const network = await prisma.network.findUnique({ where: { chainId } });
  return network?.explorerUrl ?? null;
}

/**
 * POST /api/transactions
 *
 * Records a transaction the desktop app is performing. The server stores what
 * the client reports and never derives a hash or a status of its own: if the
 * client has no hash, the record has no hash.
 *
 * Idempotent on (client, clientRef) so a network retry cannot duplicate a
 * ledger row, and unique on (txHash, chainId) so the same broadcast cannot be
 * recorded twice under different references.
 */
transactionsRouter.post(
  '/transactions',
  requireClient,
  writeLimiter,
  rejectKeyMaterial,
  validate(createTransactionSchema),
  async (req, res, next) => {
    try {
      const body = req.body as Record<string, any>;
      const clientId = req.client!.id;

      // Cross-check the asset against configuration. A client may only record
      // a transfer for an asset this backend actually defines, on the chain
      // that asset lives on.
      const asset = await prisma.asset.findUnique({
        where: { assetId: body.assetId },
        include: { network: true },
      });

      if (!asset) {
        return next(
          badRequest(
            'UNKNOWN_ASSET',
            `"${body.assetId}" is not a configured asset. The application's asset list may be ` +
              'out of date — refresh configuration and try again.',
          ),
        );
      }

      if (asset.network.chainId !== body.chainId) {
        return next(
          badRequest(
            'CHAIN_MISMATCH',
            `Asset ${asset.symbol} is configured on chain ${asset.network.chainId}, but the ` +
              `transaction reports chain ${body.chainId}.`,
          ),
        );
      }

      if (asset.isNative !== body.isNative) {
        return next(
          badRequest(
            'ASSET_TYPE_MISMATCH',
            `Asset ${asset.symbol} is configured as ${asset.isNative ? 'a native coin' : 'a token contract'}, ` +
              'which does not match the reported transaction.',
          ),
        );
      }

      if (
        !asset.isNative &&
        asset.contractAddress?.toLowerCase() !== String(body.contractAddress ?? '').toLowerCase()
      ) {
        return next(
          badRequest(
            'CONTRACT_MISMATCH',
            `The contract address reported does not match the address configured for ${asset.symbol}. ` +
              'Refresh configuration before sending.',
          ),
        );
      }

      const existing = await prisma.transactionRecord.findUnique({
        where: { clientId_clientRef: { clientId, clientRef: body.clientRef } },
      });

      if (existing) {
        return res.status(200).json({
          transaction: serializeTransaction(
            existing,
            await explorerFor(existing.chainId, existing.assetId),
          ),
          idempotent: true,
        });
      }

      const created = await prisma.transactionRecord.create({
        data: {
          clientRef: body.clientRef,
          txHash: body.txHash ?? null,
          chainId: body.chainId,
          status: body.status as TxStatus,
          assetId: body.assetId,
          symbol: body.symbol,
          decimals: body.decimals,
          isNative: body.isNative,
          contractAddress: body.contractAddress ?? null,
          fromAddress: body.fromAddress,
          toAddress: body.toAddress,
          amountRaw: body.amountRaw,
          amountDisplay: body.amountDisplay,
          nonce: body.nonce ?? null,
          errorCode: body.errorCode ?? null,
          errorMessage: body.errorMessage ?? null,
          broadcastAt: body.txHash ? new Date() : null,
          clientId,
        },
      });

      await recordAudit({
        actorType: 'client',
        action: 'transaction.recorded',
        entity: 'TransactionRecord',
        entityId: created.id,
        after: { txHash: created.txHash, status: created.status, chainId: created.chainId },
        req,
      });

      return res.status(201).json({
        transaction: serializeTransaction(created, asset.explorerUrl ?? asset.network.explorerUrl),
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        (err.meta?.target as string[] | undefined)?.includes('txHash')
      ) {
        return next(
          conflict(
            'DUPLICATE_TX_HASH',
            'That transaction hash is already recorded for this chain. The transaction was not ' +
              'sent twice.',
          ),
        );
      }
      return next(err);
    }
  },
);

/**
 * PATCH /api/transactions/:id
 *
 * Used by the client's confirmation watcher to move a record to its final
 * state once a receipt exists. Transitions are checked against the state
 * machine, and terminal states are immutable.
 */
transactionsRouter.patch(
  '/transactions/:id',
  requireClient,
  writeLimiter,
  validate(updateTransactionSchema),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = req.body as Record<string, any>;

      const existing = await prisma.transactionRecord.findUnique({ where: { id } });
      if (!existing) return next(notFound('Transaction record'));

      if (existing.clientId && existing.clientId !== req.client!.id) {
        return next(notFound('Transaction record'));
      }

      const nextStatus = body.status as TxStatus;

      if (!canTransition(existing.status, nextStatus)) {
        return next(
          conflict(
            'ILLEGAL_STATE_TRANSITION',
            describeIllegalTransition(existing.status, nextStatus),
          ),
        );
      }

      // A hash may be attached, but never changed once set: the identity of a
      // broadcast transaction is fixed.
      if (body.txHash && existing.txHash && body.txHash !== existing.txHash) {
        return next(
          conflict(
            'TX_HASH_IMMUTABLE',
            'This record already refers to a different transaction hash and cannot be reassigned.',
          ),
        );
      }

      const updated = await prisma.transactionRecord.update({
        where: { id },
        data: {
          status: nextStatus,
          txHash: existing.txHash ?? body.txHash ?? null,
          blockNumber: body.blockNumber ?? existing.blockNumber,
          gasUsed: body.gasUsed ?? existing.gasUsed,
          effectiveGasPrice: body.effectiveGasPrice ?? existing.effectiveGasPrice,
          feeRaw: body.feeRaw ?? existing.feeRaw,
          confirmations: body.confirmations ?? existing.confirmations,
          errorCode: body.errorCode ?? existing.errorCode,
          errorMessage: body.errorMessage ?? existing.errorMessage,
          confirmedAt:
            nextStatus === TxStatus.CONFIRMED ? (existing.confirmedAt ?? new Date()) : existing.confirmedAt,
          broadcastAt:
            existing.broadcastAt ?? (body.txHash || existing.txHash ? new Date() : null),
        },
      });

      await recordAudit({
        actorType: 'client',
        action: `transaction.${nextStatus.toLowerCase()}`,
        entity: 'TransactionRecord',
        entityId: updated.id,
        before: { status: existing.status },
        after: { status: updated.status, blockNumber: updated.blockNumber },
        req,
      });

      return res.json({
        transaction: serializeTransaction(
          updated,
          await explorerFor(updated.chainId, updated.assetId),
        ),
      });
    } catch (err) {
      return next(err);
    }
  },
);

/** GET /api/transactions — filtered, cursor-paginated ledger. */
transactionsRouter.get(
  '/transactions',
  requireClient,
  validate(transactionQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      const q = req.query as unknown as {
        status?: TxStatus;
        chainId?: number;
        assetId?: string;
        from?: string;
        search?: string;
        fromDate?: string;
        toDate?: string;
        limit: number;
        cursor?: string;
      };

      const where: Prisma.TransactionRecordWhereInput = {
        clientId: req.client!.id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.chainId ? { chainId: q.chainId } : {}),
        ...(q.assetId ? { assetId: q.assetId } : {}),
        ...(q.from ? { fromAddress: { equals: q.from, mode: 'insensitive' } } : {}),
        ...(q.fromDate || q.toDate
          ? {
              submittedAt: {
                ...(q.fromDate ? { gte: new Date(q.fromDate) } : {}),
                ...(q.toDate ? { lte: new Date(q.toDate) } : {}),
              },
            }
          : {}),
        ...(q.search
          ? {
              OR: [
                { txHash: { contains: q.search, mode: 'insensitive' } },
                { toAddress: { contains: q.search, mode: 'insensitive' } },
                { fromAddress: { contains: q.search, mode: 'insensitive' } },
                { symbol: { contains: q.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const rows = await prisma.transactionRecord.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > q.limit;
      const page = hasMore ? rows.slice(0, q.limit) : rows;

      const networks = await prisma.network.findMany({
        where: { chainId: { in: [...new Set(page.map((r) => r.chainId))] } },
      });
      const explorerByChain = new Map(networks.map((n) => [n.chainId, n.explorerUrl]));

      res.json({
        transactions: page.map((tx) =>
          serializeTransaction(tx, explorerByChain.get(tx.chainId) ?? null),
        ),
        nextCursor: hasMore ? page[page.length - 1]?.id : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/transactions/:id */
transactionsRouter.get('/transactions/:id', requireClient, async (req, res, next) => {
  try {
    const tx = await prisma.transactionRecord.findUnique({ where: { id: req.params.id } });

    if (!tx || (tx.clientId && tx.clientId !== req.client!.id)) {
      return next(notFound('Transaction record'));
    }

    return res.json({
      transaction: serializeTransaction(tx, await explorerFor(tx.chainId, tx.assetId)),
    });
  } catch (err) {
    return next(err);
  }
});
