import crypto from 'node:crypto';
import type { ApiClient, TxStatus } from '@prisma/client';
import { prisma } from '../lib/db';
import { logger } from '../lib/logger';
import { AppError, badRequest, forbidden } from '../lib/errors';
import { formatAmount, formatAmountShort, parseAmount } from '../lib/amount';
import { normaliseAddress } from '../lib/chain';
import * as chain from './chainService';
import * as wallet from './serverWallet';
import { recordAudit } from './audit';

/**
 * Custodial send pipeline.
 *
 * Two phases separated by explicit human confirmation in the client:
 *
 *   prepare  — validate everything, read real balances, verify the contract
 *              on-chain, check the client's spending limits, estimate the fee.
 *              Nothing is signed.
 *   confirm  — sign and broadcast the *stored* quote. The client sends back
 *              only a reference, so the transaction signed is exactly the one
 *              it was shown.
 */

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

interface StoredQuote {
  clientId: string;
  assetId: string;
  to: string;
  amountRaw: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
  createdAt: number;
}

const quotes = new Map<string, StoredQuote>();
const QUOTE_TTL_MS = 5 * 60_000;

function reapQuotes() {
  const cutoff = Date.now() - QUOTE_TTL_MS;
  for (const [ref, quote] of quotes) {
    if (quote.createdAt < cutoff) quotes.delete(ref);
  }
}

// ---------------------------------------------------------------------------
// Spending limits
// ---------------------------------------------------------------------------

/**
 * Enforces this client's cap for this asset.
 *
 * Access is opt-in: a client with no limit row for an asset cannot send it at
 * all. With one shared wallet behind every API key, that default is what stops
 * a newly issued key from being able to move everything.
 */
async function assertWithinLimits(
  client: ApiClient,
  assetId: string,
  symbol: string,
  decimals: number,
  amountRaw: bigint,
): Promise<void> {
  const limit = await prisma.spendingLimit.findUnique({
    where: { clientId_assetId: { clientId: client.id, assetId } },
  });

  if (!limit || !limit.enabled) {
    throw forbidden(
      `This installation is not authorised to send ${symbol}. An administrator must grant it a ` +
        'spending limit for this asset in the dashboard.',
    );
  }

  const maxPerTx = BigInt(limit.maxPerTxRaw);

  if (amountRaw > maxPerTx) {
    throw forbidden(
      `This transfer of ${formatAmount(amountRaw, decimals)} ${symbol} exceeds the per-transaction ` +
        `limit of ${formatAmount(maxPerTx, decimals)} ${symbol} for this installation.`,
    );
  }

  // Rolling UTC day. Counts anything that reached the network — a failed
  // broadcast is excluded, but a reverted transaction is not, because the
  // funds were committed at the time.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const spentToday = await prisma.transactionRecord.findMany({
    where: {
      clientId: client.id,
      assetId,
      submittedAt: { gte: since },
      status: { in: ['BROADCASTING', 'PENDING', 'CONFIRMED', 'FAILED'] as TxStatus[] },
    },
    select: { amountRaw: true },
  });

  const alreadySpent = spentToday.reduce((total, row) => total + BigInt(row.amountRaw), 0n);
  const maxPerDay = BigInt(limit.maxPerDayRaw);

  if (alreadySpent + amountRaw > maxPerDay) {
    const remaining = maxPerDay > alreadySpent ? maxPerDay - alreadySpent : 0n;
    throw forbidden(
      `This installation's daily limit for ${symbol} is ${formatAmount(maxPerDay, decimals)}, and ` +
        `${formatAmount(alreadySpent, decimals)} has already been sent today. ` +
        `${formatAmount(remaining, decimals)} ${symbol} remains available until 00:00 UTC.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

export interface PrepareInput {
  assetId: string;
  recipient: string;
  amount: string;
}

export async function prepare(client: ApiClient, input: PrepareInput) {
  if (!wallet.isCustodial()) {
    throw new AppError(
      503,
      'NO_SERVER_WALLET',
      'This deployment has no server wallet, so it cannot send on your behalf.',
    );
  }

  const from = wallet.address();

  const asset = await prisma.asset.findUnique({
    where: { assetId: input.assetId },
    include: { network: true },
  });

  if (!asset || !asset.enabled) {
    throw badRequest('UNKNOWN_ASSET', `"${input.assetId}" is not an available asset.`);
  }
  if (!asset.network.enabled) {
    throw badRequest('NETWORK_DISABLED', `${asset.network.name} is currently disabled.`);
  }

  const to = normaliseAddress(input.recipient, 'Recipient address');

  if (to.toLowerCase() === from.toLowerCase()) {
    throw badRequest(
      'RECIPIENT_IS_SENDER',
      'The recipient is the sending wallet itself. That would only burn a network fee.',
    );
  }

  const amountRaw = parseAmount(input.amount, asset.decimals, asset.symbol);

  await assertWithinLimits(client, asset.assetId, asset.symbol, asset.decimals, amountRaw);

  await chain.assertChainId(asset.network);

  const warnings: string[] = [];

  if (!asset.isNative) {
    const verified = await chain.verifyTokenContract(
      asset.network,
      asset.contractAddress!,
      asset.decimals,
      asset.symbol,
    );
    warnings.push(...verified.warnings);
  }

  const [assetBalance, nativeBalance] = await Promise.all([
    chain.getBalanceFor(asset, from),
    chain.getNativeBalance(asset.network, from),
  ]);

  if (assetBalance < amountRaw) {
    throw badRequest(
      'INSUFFICIENT_BALANCE',
      `The sending wallet holds ${formatAmount(assetBalance, asset.decimals)} ${asset.symbol}, ` +
        `less than the ${formatAmount(amountRaw, asset.decimals)} requested.`,
    );
  }

  const request = chain.buildTransferRequest(asset, to, amountRaw);
  const fee = await chain.estimateFee(asset.network, request, from);

  const nativeDecimals = asset.network.nativeDecimals;
  const nativeNeeded = asset.isNative ? amountRaw + fee.totalFee : fee.totalFee;

  if (nativeBalance < nativeNeeded) {
    throw badRequest(
      'INSUFFICIENT_GAS',
      `This transfer needs about ${formatAmount(fee.totalFee, nativeDecimals)} ` +
        `${asset.network.nativeSymbol} for the network fee, but the wallet holds ` +
        `${formatAmount(nativeBalance, nativeDecimals)}. Top up the sending wallet.`,
    );
  }

  if (!asset.network.isTestnet) {
    warnings.push(
      `${asset.network.name} is a live network. This transfer moves real funds and cannot be ` +
        'reversed once broadcast.',
    );
  }

  const clientRef = crypto.randomUUID();

  quotes.set(clientRef, {
    clientId: client.id,
    assetId: asset.assetId,
    to,
    amountRaw,
    gasLimit: fee.gasLimit,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    gasPrice: fee.gasPrice,
    createdAt: Date.now(),
  });
  reapQuotes();

  return {
    clientRef,
    assetId: asset.assetId,
    symbol: asset.symbol,
    decimals: asset.decimals,
    isNative: asset.isNative,
    contractAddress: asset.contractAddress,
    network: {
      key: asset.network.key,
      name: asset.network.name,
      chainId: asset.network.chainId,
      isTestnet: asset.network.isTestnet,
    },
    from,
    to,
    amountRaw: amountRaw.toString(),
    amountDisplay: formatAmount(amountRaw, asset.decimals),
    gasLimit: fee.gasLimit.toString(),
    estimatedFeeRaw: fee.totalFee.toString(),
    estimatedFeeDisplay: formatAmountShort(fee.totalFee, nativeDecimals),
    nativeSymbol: asset.network.nativeSymbol,
    assetBalanceRaw: assetBalance.toString(),
    nativeBalanceRaw: nativeBalance.toString(),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

/**
 * Serialises broadcasts per chain.
 *
 * One wallet with several clients means concurrent sends would race for the
 * same nonce and one would be dropped. Each chain's sends are queued so the
 * nonce is read and consumed inside the lock.
 */
const chainLocks = new Map<number, Promise<unknown>>();

function withChainLock<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
  const previous = chainLocks.get(chainId) ?? Promise.resolve();
  const next = previous.then(fn, fn);

  // Keep the chain alive but do not retain rejections.
  chainLocks.set(
    chainId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );

  return next;
}

export async function confirm(client: ApiClient, clientRef: string) {
  const quote = quotes.get(clientRef);

  if (!quote || quote.clientId !== client.id) {
    throw badRequest(
      'QUOTE_EXPIRED',
      'This transaction summary has expired or is not yours. Prepare the transfer again so the ' +
        'fee and balance are re-checked.',
    );
  }

  quotes.delete(clientRef);

  const asset = await prisma.asset.findUniqueOrThrow({
    where: { assetId: quote.assetId },
    include: { network: true },
  });

  const from = wallet.address();

  const record = await prisma.transactionRecord.create({
    data: {
      clientRef,
      chainId: asset.network.chainId,
      status: 'SIGNING',
      assetId: asset.assetId,
      symbol: asset.symbol,
      decimals: asset.decimals,
      isNative: asset.isNative,
      contractAddress: asset.contractAddress,
      fromAddress: from,
      toAddress: quote.to,
      amountRaw: quote.amountRaw.toString(),
      amountDisplay: formatAmount(quote.amountRaw, asset.decimals),
      clientId: client.id,
    },
  });

  try {
    // Re-verify the chain immediately before signing: configuration could
    // have changed since the quote was built.
    await chain.assertChainId(asset.network);

    const request = chain.buildTransferRequest(asset, quote.to, quote.amountRaw);

    const response = await withChainLock(asset.network.chainId, async () => {
      const nonce = await chain.getPendingNonce(asset.network, from);

      const populated = {
        ...request,
        nonce,
        gasLimit: quote.gasLimit,
        ...(quote.maxFeePerGas
          ? {
              maxFeePerGas: quote.maxFeePerGas,
              maxPriorityFeePerGas: quote.maxPriorityFeePerGas ?? 0n,
            }
          : { gasPrice: quote.gasPrice ?? 0n }),
      };

      return wallet.withPrivateKey((privateKey) =>
        chain.signAndBroadcast(asset.network, privateKey, populated),
      );
    });

    const updated = await prisma.transactionRecord.update({
      where: { id: record.id },
      data: {
        status: 'PENDING',
        txHash: response.hash,
        nonce: response.nonce,
        broadcastAt: new Date(),
      },
    });

    await recordAudit({
      actorType: 'client',
      action: 'transaction.broadcast',
      entity: 'TransactionRecord',
      entityId: updated.id,
      after: {
        txHash: response.hash,
        to: quote.to,
        amount: updated.amountDisplay,
        symbol: asset.symbol,
      },
    });

    void watchReceipt(updated.id, asset.network.chainId).catch(() => undefined);

    return {
      id: updated.id,
      clientRef,
      txHash: updated.txHash,
      status: updated.status,
      explorerUrl: `${asset.explorerUrl ?? asset.network.explorerUrl}/tx/${response.hash}`,
    };
  } catch (err) {
    const appError =
      err instanceof AppError
        ? err
        : new AppError(502, 'BROADCAST_FAILED', (err as Error)?.message ?? 'The transfer failed.');

    // Nothing reached the chain, so this is a rejection rather than a failed
    // transaction: no hash exists and no fee was paid.
    await prisma.transactionRecord.update({
      where: { id: record.id },
      data: {
        status: 'REJECTED',
        errorCode: appError.code,
        errorMessage: appError.message,
      },
    });

    throw appError;
  }
}

// ---------------------------------------------------------------------------
// Confirmation watching
// ---------------------------------------------------------------------------

/**
 * Polls for the receipt and settles the record.
 *
 * `status === 1` is the only thing that counts as success. A mined-but-
 * reverted transaction (`status === 0`) is recorded as FAILED: it is on-chain
 * and it cost gas, but it moved nothing.
 */
export async function watchReceipt(recordId: string, chainId: number): Promise<void> {
  const network = await prisma.network.findUnique({ where: { chainId } });
  if (!network) return;

  const startedAt = Date.now();
  const GIVE_UP_MS = 60 * 60_000;

  for (;;) {
    const record = await prisma.transactionRecord.findUnique({ where: { id: recordId } });
    if (!record?.txHash || record.status !== 'PENDING') return;

    if (Date.now() - startedAt > GIVE_UP_MS) {
      await prisma.transactionRecord.update({
        where: { id: recordId },
        data: {
          errorCode: 'STILL_PENDING',
          errorMessage:
            'Still pending after an hour. The transaction remains valid and may yet confirm — ' +
            'check the block explorer.',
        },
      });
      return;
    }

    try {
      const receipt = await chain.getReceipt(network, record.txHash);

      if (receipt) {
        const fee = receipt.gasUsed * (receipt.gasPrice ?? 0n);

        await prisma.transactionRecord.update({
          where: { id: recordId },
          data: {
            status: receipt.status === 1 ? 'CONFIRMED' : 'FAILED',
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.gasPrice?.toString() ?? null,
            feeRaw: fee.toString(),
            confirmations: 1,
            confirmedAt: receipt.status === 1 ? new Date() : null,
            ...(receipt.status === 0
              ? {
                  errorCode: 'EXECUTION_REVERTED',
                  errorMessage:
                    'The network included this transaction but the transfer reverted, so no funds ' +
                    'moved. The gas fee was still charged.',
                }
              : {}),
          },
        });

        logger.info(
          { recordId, txHash: record.txHash, status: receipt.status },
          'Transaction settled',
        );
        return;
      }
    } catch (err) {
      // Transient RPC failure must not settle the record; retry.
      logger.debug({ err, recordId }, 'Receipt poll failed, retrying');
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/**
 * Resumes watching anything left pending when the process restarted.
 *
 * Passenger recycles idle applications, so without this a transaction
 * broadcast just before a restart would sit at PENDING forever.
 */
export async function resumePending(): Promise<void> {
  const pending = await prisma.transactionRecord.findMany({
    where: { status: 'PENDING', txHash: { not: null } },
    select: { id: true, chainId: true },
    take: 100,
  });

  for (const record of pending) {
    void watchReceipt(record.id, record.chainId).catch(() => undefined);
  }

  if (pending.length) {
    logger.info({ count: pending.length }, 'Resumed watching pending transactions');
  }
}
