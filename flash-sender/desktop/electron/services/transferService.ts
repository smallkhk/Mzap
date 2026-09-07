import crypto from 'node:crypto';
import { Wallet, getAddress } from 'ethers';
import type {
  AssetConfig,
  TransactionRecord,
  TransferQuote,
  TransferProgressEvent,
  TxState,
} from '../../shared/types';
import { AppError } from '../lib/errors';
import { formatAmount, formatAmountShort, parseAmount } from '../lib/amount';
import * as chain from './blockchain';
import * as vault from './vault';
import * as history from './history';
import * as api from './apiClient';
import { getSettings } from './settings';
import { validateRecipient } from '../lib/validation';

/**
 * Orchestrates a transfer from validation through to a settled on-chain
 * result.
 *
 * The one rule this module exists to enforce: **the status of a transaction
 * is whatever the chain says it is.** Every state after BROADCASTING comes
 * from a real RPC response — a hash from `eth_sendRawTransaction`, a receipt
 * from `eth_getTransactionReceipt`. There is no path through this code that
 * produces a hash, a block number or a CONFIRMED status without one.
 */

type Emit = (event: TransferProgressEvent) => void;

let emitProgress: Emit = () => undefined;

export function setProgressEmitter(fn: Emit) {
  emitProgress = fn;
}

/** Quotes live only until confirmed or discarded; never persisted. */
const pendingQuotes = new Map<string, { quote: TransferQuote; asset: AssetConfig; createdAt: number }>();

const QUOTE_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/**
 * Steps 1–7 of the send flow: validate everything, read real balances, verify
 * the contract on-chain, and estimate the fee. Produces the data the
 * confirmation screen displays.
 *
 * Nothing is signed here, and nothing is broadcast.
 */
export async function prepareTransfer(params: {
  asset: AssetConfig;
  recipient: string;
  amount: string;
}): Promise<TransferQuote> {
  const { asset } = params;

  // --- 1. Wallet must be available and unlocked --------------------------
  if (!vault.isUnlocked()) {
    throw new AppError(
      'WALLET_LOCKED',
      'The wallet is locked. Unlock it with your passphrase before preparing a transfer.',
    );
  }
  const from = vault.currentAddress()!;

  // --- 2. Mainnet guard ---------------------------------------------------
  const settings = await getSettings();
  if (!asset.network.isTestnet && !settings.allowMainnet) {
    throw new AppError(
      'MAINNET_DISABLED',
      `${asset.network.name} is a mainnet network and this installation is in testnet-only mode. ` +
        'Enable mainnet in Settings if you intend to send real funds.',
    );
  }

  // --- 3. Recipient -------------------------------------------------------
  const to = validateRecipient(params.recipient, from);

  // --- 4. Amount ----------------------------------------------------------
  const amountRaw = parseAmount(params.amount, asset.decimals, asset.symbol);

  // --- 5. Network identity ------------------------------------------------
  await chain.assertChainId(asset.network);

  const warnings: string[] = [];

  // --- 6. Contract sanity, for tokens ------------------------------------
  if (!asset.isNative) {
    const verified = await chain.verifyTokenContract(
      asset.network,
      asset.contractAddress!,
      asset.decimals,
      asset.symbol,
    );
    warnings.push(...verified.warnings);
  }

  // --- 7. Balances --------------------------------------------------------
  const [assetBalance, nativeBalance] = await Promise.all([
    chain.getBalanceFor(asset, from),
    chain.getNativeBalance(asset.network, from),
  ]);

  if (assetBalance.raw < amountRaw) {
    throw new AppError(
      'INSUFFICIENT_BALANCE',
      `This wallet holds ${formatAmount(assetBalance.raw, asset.decimals)} ${asset.symbol}, ` +
        `which is less than the ${formatAmount(amountRaw, asset.decimals)} ${asset.symbol} you ` +
        'are trying to send.',
    );
  }

  // --- 8. Fee estimation --------------------------------------------------
  const request = chain.buildTransferRequest(asset, to, amountRaw);
  const fee = await chain.estimateFee(asset.network, request, from);

  const nativeSymbol = asset.network.nativeSymbol;
  const nativeDecimals = asset.network.nativeDecimals;

  // For a native send, the fee and the amount come out of the same balance.
  const nativeRequired = asset.isNative ? amountRaw + fee.totalFee : fee.totalFee;

  if (nativeBalance < nativeRequired) {
    const shortfall = nativeRequired - nativeBalance;
    throw new AppError(
      'INSUFFICIENT_GAS',
      asset.isNative
        ? `Sending ${formatAmount(amountRaw, asset.decimals)} ${asset.symbol} plus a network fee ` +
          `of about ${formatAmount(fee.totalFee, nativeDecimals)} ${nativeSymbol} needs ` +
          `${formatAmount(nativeRequired, nativeDecimals)} ${nativeSymbol}, but this wallet holds ` +
          `${formatAmount(nativeBalance, nativeDecimals)}. Reduce the amount by at least ` +
          `${formatAmount(shortfall, nativeDecimals)} ${nativeSymbol}, or use MAX.`
        : `Sending a token costs a network fee in ${nativeSymbol}. This transfer needs about ` +
          `${formatAmount(fee.totalFee, nativeDecimals)} ${nativeSymbol}, but the wallet holds ` +
          `only ${formatAmount(nativeBalance, nativeDecimals)} ${nativeSymbol}. Add at least ` +
          `${formatAmount(shortfall, nativeDecimals)} ${nativeSymbol} to ${from} and try again.`,
    );
  }

  if (!asset.network.isTestnet) {
    warnings.push(
      `${asset.network.name} is a live network. This transfer moves real funds and cannot be ` +
        'reversed once broadcast.',
    );
  }

  const clientRef = crypto.randomUUID();

  const quote: TransferQuote = {
    clientRef,
    assetId: asset.id,
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
    maxFeePerGas: fee.maxFeePerGas?.toString() ?? null,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas?.toString() ?? null,
    gasPrice: fee.gasPrice?.toString() ?? null,
    estimatedFeeRaw: fee.totalFee.toString(),
    estimatedFeeDisplay: formatAmountShort(fee.totalFee, nativeDecimals, 8),
    nativeSymbol,
    assetBalanceRaw: assetBalance.raw.toString(),
    nativeBalanceRaw: nativeBalance.toString(),
    warnings,
  };

  pendingQuotes.set(clientRef, { quote, asset, createdAt: Date.now() });
  reapQuotes();

  return quote;
}

function reapQuotes() {
  const cutoff = Date.now() - QUOTE_TTL_MS;
  for (const [ref, entry] of pendingQuotes) {
    if (entry.createdAt < cutoff) pendingQuotes.delete(ref);
  }
}

/**
 * Computes the largest sendable amount.
 *
 * For a token this is the whole balance. For a native coin the fee must come
 * out of the same balance, so the fee is estimated first and subtracted —
 * which is why MAX on a native asset can still leave a non-zero remainder.
 */
export async function computeMax(asset: AssetConfig): Promise<{ amount: string; note: string | null }> {
  if (!vault.isUnlocked()) {
    throw new AppError('WALLET_LOCKED', 'Unlock the wallet to read its balance.');
  }
  const from = vault.currentAddress()!;

  await chain.assertChainId(asset.network);
  const balance = await chain.getBalanceFor(asset, from);

  if (!asset.isNative) {
    return { amount: formatAmount(balance.raw, asset.decimals), note: null };
  }

  if (balance.raw === 0n) {
    return { amount: '0', note: null };
  }

  // Estimate against a self-send of 1 wei purely to size the gas cost; the
  // request is never signed or sent.
  const probe = chain.buildTransferRequest(asset, from, 1n);
  const fee = await chain.estimateFee(asset.network, probe, from);

  // A small safety margin above the estimate, so a base-fee rise between the
  // estimate and inclusion does not make the transaction unaffordable.
  const reserve = (fee.totalFee * 115n) / 100n;

  if (balance.raw <= reserve) {
    throw new AppError(
      'INSUFFICIENT_GAS',
      `The whole balance (${formatAmount(balance.raw, asset.decimals)} ${asset.symbol}) is less ` +
        `than the network fee of about ${formatAmount(reserve, asset.decimals)} ${asset.symbol}, ` +
        'so there is nothing that can be sent.',
    );
  }

  const sendable = balance.raw - reserve;

  return {
    amount: formatAmount(sendable, asset.decimals),
    note:
      `About ${formatAmount(reserve, asset.decimals)} ${asset.symbol} has been held back to pay ` +
      'the network fee.',
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Signs and broadcasts a previously prepared quote.
 *
 * Called only after the user has explicitly confirmed the details. The quote
 * is looked up by reference rather than re-supplied by the caller, so the
 * transaction that is signed is exactly the one that was shown.
 */
export async function executeTransfer(clientRef: string): Promise<TransactionRecord> {
  const entry = pendingQuotes.get(clientRef);

  if (!entry) {
    throw new AppError(
      'QUOTE_EXPIRED',
      'This transaction summary has expired. Prepare the transfer again so the fee and balance ' +
        'are re-checked before sending.',
    );
  }

  const { quote, asset } = entry;
  pendingQuotes.delete(clientRef);

  const settings = await getSettings();
  const now = new Date().toISOString();

  let record: TransactionRecord = {
    id: clientRef,
    clientRef,
    txHash: null,
    chainId: asset.network.chainId,
    networkName: asset.network.name,
    status: 'SIGNING',
    assetId: asset.id,
    symbol: asset.symbol,
    decimals: asset.decimals,
    isNative: asset.isNative,
    contractAddress: asset.contractAddress,
    fromAddress: quote.from,
    toAddress: quote.to,
    amountRaw: quote.amountRaw,
    amountDisplay: quote.amountDisplay,
    blockNumber: null,
    gasUsed: null,
    effectiveGasPrice: null,
    feeRaw: null,
    feeDisplay: null,
    nativeSymbol: quote.nativeSymbol,
    nativeDecimals: asset.network.nativeDecimals,
    nonce: null,
    confirmations: 0,
    errorCode: null,
    errorMessage: null,
    submittedAt: now,
    broadcastAt: null,
    confirmedAt: null,
    explorerUrl: null,
  };

  await history.upsertTransaction(record);
  emitProgress({ clientRef, state: 'SIGNING', message: 'Signing the transaction locally…' });

  try {
    // Re-verify the chain immediately before signing. Configuration could have
    // been refreshed, or an RPC endpoint swapped, since the quote was built.
    await chain.assertChainId(asset.network);

    const request = chain.buildTransferRequest(asset, quote.to, BigInt(quote.amountRaw));

    const populated = {
      ...request,
      gasLimit: BigInt(quote.gasLimit),
      ...(quote.maxFeePerGas
        ? {
            maxFeePerGas: BigInt(quote.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(quote.maxPriorityFeePerGas ?? '0'),
          }
        : { gasPrice: BigInt(quote.gasPrice ?? '0') }),
    };

    emitProgress({ clientRef, state: 'BROADCASTING', message: 'Broadcasting to the network…' });

    // The private key is borrowed for the duration of this call only, and is
    // never returned out of the vault.
    const response = await vault.withPrivateKey(async (key) => {
      const hex = `0x${key.toString('hex')}`;
      try {
        return await chain.signAndBroadcast(asset.network, hex, populated);
      } finally {
        // Nothing to wipe here: `hex` is an immutable string, which is why the
        // key never leaves this closure and the vault holds the Buffer.
      }
    });

    // From here on, the hash is the node's, not ours.
    record = {
      ...record,
      status: 'PENDING',
      txHash: response.hash,
      nonce: response.nonce,
      broadcastAt: new Date().toISOString(),
      explorerUrl: `${asset.explorerUrl}/tx/${response.hash}`,
    };
    await history.upsertTransaction(record);

    emitProgress({
      clientRef,
      state: 'PENDING',
      txHash: response.hash,
      message: 'Broadcast. Waiting for the network to include it in a block…',
    });

    // Record on the backend. A backend outage must not lose a transaction that
    // is already on-chain, so this is best-effort and non-blocking.
    void recordRemotely(record).catch(() => undefined);

    // Watch for the receipt in the background; resolve the IPC call now so the
    // UI can show the pending state immediately.
    void watchTransaction(record, asset, settings.minConfirmations);

    return record;
  } catch (err) {
    const appError =
      err instanceof AppError
        ? err
        : new AppError('UNEXPECTED_ERROR', (err as Error)?.message ?? 'The transfer failed.');

    // A failure before broadcast is a rejection, not a failed transaction:
    // nothing reached the chain and no fee was paid.
    const failed: TransactionRecord = {
      ...record,
      status: record.txHash ? 'FAILED' : 'REJECTED',
      errorCode: appError.code,
      errorMessage: appError.message,
    };

    await history.upsertTransaction(failed);
    emitProgress({
      clientRef,
      state: failed.status,
      message: appError.message,
      errorCode: appError.code,
    });

    void recordRemotely(failed).catch(() => undefined);

    throw appError;
  }
}

/** Marks a prepared transfer as rejected by the user at the confirmation step. */
export async function rejectTransfer(clientRef: string): Promise<void> {
  pendingQuotes.delete(clientRef);
  emitProgress({ clientRef, state: 'REJECTED', message: 'Cancelled. Nothing was sent.' });
}

// ---------------------------------------------------------------------------
// Confirmation watching
// ---------------------------------------------------------------------------

const watching = new Set<string>();

/**
 * Polls for the receipt and settles the record.
 *
 * A mined-but-reverted transaction (`receipt.status === 0`) is recorded as
 * FAILED. It exists on-chain and it cost gas, but it did not transfer
 * anything, and the UI says so.
 */
export async function watchTransaction(
  record: TransactionRecord,
  asset: AssetConfig,
  minConfirmations: number,
): Promise<void> {
  if (!record.txHash || watching.has(record.txHash)) return;
  watching.add(record.txHash);

  const startedAt = Date.now();
  const SLOW_WARNING_MS = 5 * 60_000;
  const GIVE_UP_MS = 60 * 60_000;

  try {
    let warned = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const elapsed = Date.now() - startedAt;

      if (elapsed > GIVE_UP_MS) {
        await settle(record.clientRef, {
          status: 'PENDING',
          errorCode: 'STILL_PENDING',
          errorMessage:
            'This transaction has been pending for over an hour. It is still valid and may yet ' +
            'confirm — open it on the block explorer to check its current state.',
        });
        return;
      }

      if (!warned && elapsed > SLOW_WARNING_MS) {
        warned = true;
        emitProgress({
          clientRef: record.clientRef,
          state: 'PENDING',
          txHash: record.txHash,
          message:
            'Still pending after 5 minutes. The network may be congested or the fee may be low.',
        });
      }

      let receipt = null;
      try {
        receipt = await chain.getReceipt(asset.network, record.txHash);
      } catch {
        // A transient RPC failure must not settle the record; retry.
      }

      if (receipt) {
        const confirmations = await receipt.confirmations().catch(() => 0);

        if (receipt.status === 0) {
          await settle(record.clientRef, {
            status: 'FAILED',
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.gasPrice?.toString() ?? null,
            feeRaw: (receipt.gasUsed * (receipt.gasPrice ?? 0n)).toString(),
            confirmations: Number(confirmations),
            errorCode: 'EXECUTION_REVERTED',
            errorMessage:
              'The network included this transaction but the transfer reverted, so no funds ' +
              'moved. The gas fee was still charged. The token contract may restrict transfers, ' +
              'or the balance may have changed after the fee was estimated.',
          });
          return;
        }

        if (Number(confirmations) >= minConfirmations) {
          await settle(record.clientRef, {
            status: 'CONFIRMED',
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.gasPrice?.toString() ?? null,
            feeRaw: (receipt.gasUsed * (receipt.gasPrice ?? 0n)).toString(),
            confirmations: Number(confirmations),
            confirmedAt: new Date().toISOString(),
          });
          return;
        }

        emitProgress({
          clientRef: record.clientRef,
          state: 'PENDING',
          txHash: record.txHash,
          blockNumber: receipt.blockNumber,
          confirmations: Number(confirmations),
          message: `Included in block ${receipt.blockNumber}. Waiting for ${minConfirmations} confirmation(s).`,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  } finally {
    watching.delete(record.txHash);
  }
}

async function settle(clientRef: string, patch: Partial<TransactionRecord>) {
  const existing = await history.getTransaction(clientRef);
  if (!existing) return;

  // Fees are always denominated in the network's native coin, so they are
  // formatted with the native decimals — not the asset's.
  const feeDisplay = patch.feeRaw
    ? `${formatAmountShort(patch.feeRaw, existing.nativeDecimals, 8)} ${existing.nativeSymbol}`
    : existing.feeDisplay;

  const updated = await history.patchTransaction(clientRef, { ...patch, feeDisplay });
  if (!updated) return;

  emitProgress({
    clientRef,
    state: updated.status,
    txHash: updated.txHash,
    blockNumber: updated.blockNumber,
    confirmations: updated.confirmations,
    message: updated.errorMessage ?? undefined,
    errorCode: updated.errorCode ?? undefined,
  });

  void recordRemotely(updated).catch(() => undefined);
}

/**
 * Mirrors a record to the backend ledger. Failures are swallowed: the local
 * store is authoritative for the user, and a backend outage must never make a
 * real on-chain transaction disappear from their history.
 */
const remoteIds = new Map<string, string>();

async function recordRemotely(record: TransactionRecord): Promise<void> {
  const existingId = remoteIds.get(record.clientRef);

  if (existingId) {
    await api.updateTransaction(existingId, {
      status: record.status,
      txHash: record.txHash,
      blockNumber: record.blockNumber,
      gasUsed: record.gasUsed,
      effectiveGasPrice: record.effectiveGasPrice,
      feeRaw: record.feeRaw,
      confirmations: record.confirmations,
      errorCode: record.errorCode,
      errorMessage: record.errorMessage,
    });
    return;
  }

  const created = await api.recordTransaction({
    clientRef: record.clientRef,
    txHash: record.txHash,
    chainId: record.chainId,
    status: record.status,
    assetId: record.assetId,
    symbol: record.symbol,
    decimals: record.decimals,
    isNative: record.isNative,
    contractAddress: record.contractAddress,
    fromAddress: record.fromAddress,
    toAddress: record.toAddress,
    amountRaw: record.amountRaw,
    amountDisplay: record.amountDisplay,
    nonce: record.nonce,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
  });

  remoteIds.set(record.clientRef, created.transaction.id);
}

/**
 * Resumes watching anything that was in flight when the app last closed.
 * Called once at startup, after configuration has loaded.
 */
export async function resumeUnsettled(assets: AssetConfig[], minConfirmations: number) {
  const unsettled = await history.findUnsettled();

  for (const record of unsettled) {
    const asset = assets.find((a) => a.id === record.assetId && a.chainId === record.chainId);
    if (asset) void watchTransaction(record, asset, minConfirmations);
  }
}

/** Derives the address for a private key without unlocking anything. */
export function addressForPrivateKey(privateKey: string): string {
  try {
    return getAddress(new Wallet(privateKey).address);
  } catch {
    throw new AppError(
      'INVALID_PRIVATE_KEY',
      'That is not a valid private key. Expected 64 hexadecimal characters, optionally prefixed ' +
        'with 0x.',
    );
  }
}

export type { TxState };
