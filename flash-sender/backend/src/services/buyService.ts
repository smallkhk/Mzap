import crypto from 'node:crypto';
import type { ApiClient, Network } from '@prisma/client';
import { Contract, getAddress } from 'ethers';
import { prisma } from '../lib/db';
import { config } from '../config';
import { logger } from '../lib/logger';
import { AppError, badRequest } from '../lib/errors';
import { formatAmount, parseAmount } from '../lib/amount';
import * as chain from './chainService';
import * as serverWallet from './serverWallet';
import * as buyWallet from './buyWallet';
import { getBuySettings } from './appSettings';
import { recordAudit } from './audit';
import { ERC20_APPROVE_ABI } from '../lib/pancakeswap';

/**
 * The buy / "Generate tokens" pipeline.
 *
 * Same two-phase shape as the send pipeline for the same reason: `prepare`
 * reads real state and quotes a real route, nothing is signed; `confirm`
 * re-verifies and executes exactly the route that was quoted, referenced by
 * an opaque id rather than re-submitted, so a tampered client cannot change
 * what gets bought between the screen and the signature.
 *
 * Execution goes through LI.FI. It aggregates across many underlying
 * on-chain routers — Fly, 1inch, Nordstern, and whichever on-chain DEX
 * actually has liquidity for the pair, the same pool jumper.xyz's own UI
 * draws from, since Jumper is LI.FI's own front-end — and a single quote
 * call only returns LI.FI's own default pick among them, not necessarily
 * the best one. This app asks for every route LI.FI can find and picks
 * whichever actually returns the most, never trusting LI.FI's default
 * ordering. It never hand-builds the swap calldata itself: it signs and
 * broadcasts LI.FI's own `transactionRequest` for the route it picked,
 * unmodified, after re-estimating gas itself immediately before signing.
 * 1inch is queried directly too, as a second, independent quote for
 * comparison — it is never used to execute.
 *
 * A customer's purchase lands in their own deposit wallet, separate from
 * the shared custodial wallet the send feature actually spends from — left
 * there, it would be unreachable by the rest of the app. When this
 * deployment runs a custodial wallet, `confirm` sweeps the purchase there
 * immediately after the swap (and the markup skim, if any), the same kind
 * of on-chain transfer as the skim itself, just addressed to the custodial
 * wallet instead of the profit address.
 */

// ---------------------------------------------------------------------------
// Who is buying, and how they sign
// ---------------------------------------------------------------------------

export type BuyIdentity = { kind: 'admin' } | { kind: 'client'; client: ApiClient };

async function resolveFromAddress(identity: BuyIdentity): Promise<string> {
  if (identity.kind === 'admin') return serverWallet.address();

  if (!identity.client.buyWalletAddress) {
    throw badRequest(
      'NO_BUY_WALLET',
      'Generate your deposit address first, then fund it before buying.',
    );
  }
  return identity.client.buyWalletAddress;
}

async function withSigner<T>(
  identity: BuyIdentity,
  fn: (privateKeyHex: string) => Promise<T>,
): Promise<T> {
  if (identity.kind === 'admin') return serverWallet.withPrivateKey(fn);

  if (identity.client.buyWalletIndex === null) {
    throw badRequest(
      'NO_BUY_WALLET',
      'Generate your deposit address first, then fund it before buying.',
    );
  }
  return buyWallet.withDerivedKey(identity.client.buyWalletIndex, fn);
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

// The conventional placeholder both 1inch and LI.FI use for "the chain's
// native coin" where an ERC-20 address is otherwise expected. Never
// dereferenced on-chain — it only appears in these two APIs' request URLs.
const NATIVE_PSEUDO_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// A floor under LI.FI's own quoted output, absorbing normal price movement
// between quoting and broadcasting. LI.FI reports its own `toAmountMin`
// already adjusted for its chosen route's slippage; this is an *additional*
// margin this app applies on top, not a replacement for it.
const SLIPPAGE_BPS = 100n; // 1%

// How much price impact LI.FI is told it may accept when deciding whether a
// route is viable at all. This is a search parameter, not a safety margin —
// SLIPPAGE_BPS above still applies to whatever actually executes, on top of
// whatever this is set to. A tight value here silently returns *zero*
// routes for a thin-liquidity pair (most meme coins) rather than a worse
// quote; loosened so those tokens actually get a route to compare, matching
// what a request-side slippage more suited to that reality looks like.
const LIFI_REQUEST_SLIPPAGE = 0.05; // 5%

// The real, verified USDT deployment — not just any asset a dashboard admin
// might have labeled "USDT". Checked against both a live on-chain symbol()
// read and LI.FI's own curated token list before being hardcoded here. This
// is the address and decimals actually used whenever USDT is selected to
// spend, regardless of what a same-symbol asset row in the catalog has
// configured — that row is only consulted for its label. Deliberately
// scoped to BNB Smart Chain only; buying rejects USDT spends on any other
// chain until a verified address is added for it.
const REAL_USDT: Record<number, { address: string; decimals: number }> = {
  56: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 }, // BNB Smart Chain
};

interface LifiQuote {
  amountOutRaw: bigint;
  amountOutMinRaw: bigint;
  approvalAddress: string;
  toolName: string;
  transactionRequest: { to: string; data: string; value: string };
}

interface LifiRoute {
  toAmount?: string;
  steps?: Record<string, unknown>[];
}

/**
 * `/v1/advanced/routes` returns every route LI.FI can find across all of its
 * integrated tools in one call — this app picks whichever actually returns
 * the most, rather than trusting `/v1/quote`'s single default pick. The
 * winning route's first step is then turned into a signable transaction via
 * `/v1/advanced/stepTransaction`, which re-quotes it fresh in the process —
 * this app signs that verbatim (after its own fresh gas estimate on top),
 * never hand-building swap calldata itself.
 */
async function quoteLifi(
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fromAddress: string,
  apiKey: string | undefined,
): Promise<LifiQuote | null> {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(apiKey ? { 'x-lifi-api-key': apiKey } : {}),
  };

  try {
    const routesRes = await fetch('https://li.quest/v1/advanced/routes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fromChainId: chainId,
        toChainId: chainId,
        fromTokenAddress: tokenIn,
        toTokenAddress: tokenOut,
        fromAmount: amountIn.toString(),
        fromAddress,
        toAddress: fromAddress, // the purchase lands back in the funding wallet
        options: { integrator: 'flash-sender', slippage: LIFI_REQUEST_SLIPPAGE, order: 'RECOMMENDED' },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!routesRes.ok) return null;

    const routesBody = (await routesRes.json()) as { routes?: LifiRoute[] };
    const routes = routesBody.routes;
    if (!routes || routes.length === 0) return null;

    let best: LifiRoute | null = null;
    let bestOut = -1n;
    for (const route of routes) {
      if (!route.toAmount) continue;
      const out = BigInt(route.toAmount);
      if (out > bestOut) {
        bestOut = out;
        best = route;
      }
    }
    const bestStep = best?.steps?.[0];
    if (!bestStep) return null;

    const txRes = await fetch('https://li.quest/v1/advanced/stepTransaction', {
      method: 'POST',
      headers,
      body: JSON.stringify(bestStep),
      signal: AbortSignal.timeout(15_000),
    });
    if (!txRes.ok) return null;

    const txBody = (await txRes.json()) as {
      tool?: string;
      estimate?: { toAmount?: string; toAmountMin?: string; approvalAddress?: string };
      transactionRequest?: { to?: string; data?: string; value?: string };
    };

    const { estimate, transactionRequest } = txBody;
    if (
      !estimate?.toAmount ||
      !estimate.toAmountMin ||
      !estimate.approvalAddress ||
      !transactionRequest?.to ||
      !transactionRequest.data
    ) {
      return null;
    }

    return {
      amountOutRaw: BigInt(estimate.toAmount),
      amountOutMinRaw: BigInt(estimate.toAmountMin),
      approvalAddress: getAddress(estimate.approvalAddress),
      toolName: txBody.tool ?? (bestStep.tool as string | undefined) ?? 'unknown',
      transactionRequest: {
        to: getAddress(transactionRequest.to),
        data: transactionRequest.data,
        value: transactionRequest.value ?? '0x0',
      },
    };
  } catch {
    return null;
  }
}

/** 1inch only indexes BSC mainnet, and only when an API key is configured. Quote-only — never used to execute. */
async function quote1inch(
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  apiKey: string | undefined,
): Promise<bigint | null> {
  if (!apiKey || chainId !== 56) return null;

  try {
    const url =
      `https://api.1inch.dev/swap/v6.0/${chainId}/quote?` +
      `src=${tokenIn}&dst=${tokenOut}&amount=${amountIn.toString()}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;

    const body = (await res.json()) as { dstAmount?: string; toAmount?: string };
    const amountOutRaw = body.dstAmount ?? body.toAmount;
    return amountOutRaw ? BigInt(amountOutRaw) : null;
  } catch {
    return null;
  }
}

interface StoredBuyQuote {
  identity: BuyIdentity;
  chainId: number;
  networkKey: string;
  spendAssetId: string;
  spendIsNative: boolean;
  spendContractAddress: string | null;
  spendDecimals: number;
  spendSymbol: string;
  amountInRaw: bigint;
  tokenAddress: string;
  tokenDecimals: number;
  tokenSymbol: string | null;
  approvalAddress: string;
  transactionRequest: { to: string; data: string; value: string };
  amountOutRaw: bigint;
  amountOutMin: bigint;
  createdAt: number;
}

const quotes = new Map<string, StoredBuyQuote>();
const QUOTE_TTL_MS = 2 * 60_000; // DEX prices move faster than a fixed send fee; a shorter window than sendService's.

function reapQuotes() {
  const cutoff = Date.now() - QUOTE_TTL_MS;
  for (const [ref, q] of quotes) if (q.createdAt < cutoff) quotes.delete(ref);
}

export interface PrepareBuyInput {
  spendAssetId: string;
  tokenAddress: string;
  amountIn: string;
}

export async function prepareBuy(identity: BuyIdentity, input: PrepareBuyInput) {
  const spendAsset = await prisma.asset.findUnique({
    where: { assetId: input.spendAssetId },
    include: { network: true },
  });
  if (!spendAsset || !spendAsset.enabled) {
    throw badRequest('UNKNOWN_ASSET', `No asset with id "${input.spendAssetId}".`);
  }

  // Buying is deliberately restricted to the chain's native coin or USDT.
  // For USDT, the address and decimals actually used on-chain always come
  // from REAL_USDT below, never from this asset row's own contractAddress
  // or decimals fields — a dashboard asset's symbol is whatever whoever
  // added it typed in, and its contract address could be wrong by mistake
  // or by design. The row is only consulted for its *label*, to keep the
  // picker friendly; everything that actually reads a balance, approves, or
  // spends uses the hardcoded, verified contract, so a mislabeled or fake
  // "USDT" asset can never be spent as if it were real USDT.
  let spendContractAddress: string | null = null;
  let spendDecimals = spendAsset.decimals;

  if (!spendAsset.isNative) {
    if (spendAsset.symbol.toUpperCase() !== 'USDT') {
      throw badRequest(
        'UNSUPPORTED_SPEND_ASSET',
        `Buying only accepts ${spendAsset.network.nativeSymbol} or USDT to spend, not ${spendAsset.symbol}.`,
      );
    }
    const real = REAL_USDT[spendAsset.network.chainId];
    if (!real) {
      throw badRequest(
        'UNSUPPORTED_SPEND_ASSET',
        `Buying with USDT isn't set up for ${spendAsset.network.name} yet.`,
      );
    }
    spendContractAddress = real.address;
    spendDecimals = real.decimals;
  }

  const fromAddress = await resolveFromAddress(identity);
  await chain.assertChainId(spendAsset.network);

  const amountInRaw = parseAmount(input.amountIn, spendDecimals, spendAsset.symbol);
  const tokenAddress = getAddress(input.tokenAddress);

  // Read the target token live — never trust a pasted address without
  // confirming it is a real token contract, same rule the send pipeline
  // applies to configured assets.
  const provider = chain.getProvider(spendAsset.network);
  if ((await provider.getCode(tokenAddress)) === '0x') {
    throw badRequest('NOT_A_CONTRACT', `There is no contract deployed at ${tokenAddress}.`);
  }
  const tokenContract = new Contract(
    tokenAddress,
    ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
    provider,
  );

  let tokenDecimals: number;
  try {
    tokenDecimals = Number(await tokenContract.decimals!());
  } catch {
    throw badRequest(
      'NOT_A_TOKEN_CONTRACT',
      `The contract at ${tokenAddress} does not expose a standard decimals() function.`,
    );
  }
  const tokenSymbol = await tokenContract.symbol!().catch(() => null);

  // Balance checks against the address that will actually fund the swap.
  const spendBalance = spendAsset.isNative
    ? await chain.getNativeBalance(spendAsset.network, fromAddress)
    : await chain.getTokenBalance(spendAsset.network, spendContractAddress!, fromAddress);

  if (spendBalance < amountInRaw) {
    throw badRequest(
      'INSUFFICIENT_BALANCE',
      `This wallet holds ${formatAmount(spendBalance, spendDecimals)} ${spendAsset.symbol}, ` +
        `less than the ${formatAmount(amountInRaw, spendDecimals)} requested.`,
    );
  }

  const spendPathAddress = spendAsset.isNative ? NATIVE_PSEUDO_ADDRESS : getAddress(spendContractAddress!);

  const [lifi, oneInchOut, buySettings] = await Promise.all([
    quoteLifi(spendAsset.network.chainId, spendPathAddress, tokenAddress, amountInRaw, fromAddress, config.LIFI_API_KEY),
    quote1inch(spendAsset.network.chainId, spendPathAddress, tokenAddress, amountInRaw, config.ONEINCH_API_KEY),
    getBuySettings(),
  ]);

  if (!lifi) {
    throw badRequest(
      'NO_ROUTE_FOUND',
      `No route was found from ${spendAsset.symbol} to this token. It may have no real liquidity ` +
        `on ${spendAsset.network.name} — check the contract address carefully before trying again.`,
    );
  }

  // LI.FI's own toAmountMin already accounts for its chosen route's
  // slippage; this app's own floor sits under that as an additional
  // margin, so a re-check just before broadcasting still has room.
  const amountOutMin = lifi.amountOutMinRaw - (lifi.amountOutMinRaw * SLIPPAGE_BPS) / 10_000n;

  const quoteRef = crypto.randomUUID();
  quotes.set(quoteRef, {
    identity,
    chainId: spendAsset.network.chainId,
    networkKey: spendAsset.network.key,
    spendAssetId: spendAsset.assetId,
    spendIsNative: spendAsset.isNative,
    spendContractAddress,
    spendDecimals,
    spendSymbol: spendAsset.symbol,
    amountInRaw,
    tokenAddress,
    tokenDecimals,
    tokenSymbol,
    approvalAddress: lifi.approvalAddress,
    transactionRequest: lifi.transactionRequest,
    amountOutRaw: lifi.amountOutRaw,
    amountOutMin,
    createdAt: Date.now(),
  });
  reapQuotes();

  const markupBps = identity.kind === 'client' ? buySettings.buyMarkupBps : 0;
  const buyerAmountRaw = lifi.amountOutRaw - (lifi.amountOutRaw * BigInt(markupBps)) / 10_000n;

  const comparisons: { source: string; amountOutDisplay: string }[] = [
    { source: 'lifi', amountOutDisplay: formatAmount(lifi.amountOutRaw, tokenDecimals) },
  ];
  if (oneInchOut !== null) {
    comparisons.push({ source: '1inch', amountOutDisplay: formatAmount(oneInchOut, tokenDecimals) });
  }

  return {
    quoteRef,
    tokenAddress,
    tokenSymbol,
    tokenDecimals,
    spendSymbol: spendAsset.symbol,
    amountInDisplay: formatAmount(amountInRaw, spendDecimals),
    marketAmountOutDisplay: formatAmount(lifi.amountOutRaw, tokenDecimals),
    buyerAmountOutDisplay: formatAmount(buyerAmountRaw, tokenDecimals),
    markupBps,
    executesVia: 'lifi' as const,
    executionTool: lifi.toolName,
    comparisons,
    expiresInSeconds: Math.floor(QUOTE_TTL_MS / 1000),
  };
}

// ---------------------------------------------------------------------------
// Executing
// ---------------------------------------------------------------------------

const chainLocks = new Map<number, Promise<unknown>>();
function withChainLock<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
  const previous = chainLocks.get(chainId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  chainLocks.set(chainId, next.then(() => undefined, () => undefined));
  return next;
}

/** Polls for a receipt without touching the transaction ledger — used for the approve leg, which isn't user-facing history. */
async function waitForReceipt(network: Network, txHash: string, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const receipt = await chain.getReceipt(network, txHash);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new AppError(504, 'RECEIPT_TIMEOUT', 'The transaction was broadcast but did not confirm in time.');
}

export async function confirmBuy(identity: BuyIdentity, quoteRef: string) {
  const quote = quotes.get(quoteRef);
  const sameIdentity =
    quote &&
    ((quote.identity.kind === 'admin' && identity.kind === 'admin') ||
      (quote.identity.kind === 'client' &&
        identity.kind === 'client' &&
        quote.identity.client.id === identity.client.id));

  if (!quote || !sameIdentity) {
    throw badRequest(
      'QUOTE_EXPIRED',
      'This quote has expired or is not yours. Request a new quote so the rate and route are re-checked.',
    );
  }
  quotes.delete(quoteRef);

  const network = await prisma.network.findUniqueOrThrow({ where: { key: quote.networkKey } });
  const fromAddress = await resolveFromAddress(identity);

  await chain.assertChainId(network);

  const record = await prisma.transactionRecord.create({
    data: {
      clientRef: quoteRef,
      chainId: network.chainId,
      status: 'SIGNING',
      assetId: `buy:${quote.tokenAddress.toLowerCase()}`,
      symbol: quote.tokenSymbol ?? 'TOKEN',
      decimals: quote.tokenDecimals,
      isNative: false,
      contractAddress: quote.tokenAddress,
      fromAddress,
      toAddress: fromAddress, // the purchase lands back in the funding wallet
      amountRaw: quote.amountOutMin.toString(),
      amountDisplay: formatAmount(quote.amountOutMin, quote.tokenDecimals),
      clientId: identity.kind === 'client' ? identity.client.id : null,
    },
  });

  try {
    const tokenBefore = await chain.getTokenBalance(network, quote.tokenAddress, fromAddress);

    // Estimated and signed with the same rigor as a plain send: gas is
    // re-estimated fresh right before signing (with the same 20% headroom
    // `chain.estimateFee` applies everywhere else) rather than trusting the
    // gas values embedded in the quote, which were current at quote time
    // and may be stale by the time this actually broadcasts. The `to` and
    // `data` from the quote are signed verbatim — this app never edits a
    // third-party route's calldata, only decides whether to sign it.
    const swapHash = await withChainLock(network.chainId, () =>
      withSigner(identity, async (privateKey) => {
        // ERC-20 spend needs an approval before the route's contract can
        // pull funds. LI.FI names the exact address to approve — it is
        // often not the same contract the transaction itself is sent to.
        if (!quote.spendIsNative) {
          const allowanceContract = new Contract(
            quote.spendContractAddress!,
            ERC20_APPROVE_ABI,
            chain.getProvider(network),
          );
          const currentAllowance: bigint = await allowanceContract.allowance!(
            fromAddress,
            quote.approvalAddress,
          );

          if (currentAllowance < quote.amountInRaw) {
            const approveIface = new Contract(quote.spendContractAddress!, ERC20_APPROVE_ABI).interface;
            const approveRequest = {
              to: getAddress(quote.spendContractAddress!),
              data: approveIface.encodeFunctionData('approve', [quote.approvalAddress, quote.amountInRaw]),
              value: 0n,
            };
            const approveFee = await chain.estimateFee(network, approveRequest, fromAddress);
            const approveNonce = await chain.getPendingNonce(network, fromAddress);

            const approveResponse = await chain.signAndBroadcast(network, privateKey, {
              ...approveRequest,
              nonce: approveNonce,
              gasLimit: approveFee.gasLimit,
              ...(approveFee.maxFeePerGas
                ? {
                    maxFeePerGas: approveFee.maxFeePerGas,
                    maxPriorityFeePerGas: approveFee.maxPriorityFeePerGas ?? 0n,
                  }
                : { gasPrice: approveFee.gasPrice ?? 0n }),
            });
            await waitForReceipt(network, approveResponse.hash);
            await recordAudit({
              actorType: identity.kind === 'client' ? 'client' : 'admin',
              action: 'buy.approve',
              entity: 'TransactionRecord',
              entityId: record.id,
              after: { txHash: approveResponse.hash, spender: quote.approvalAddress },
            });
          }
        }

        const swapRequest = {
          to: quote.transactionRequest.to,
          data: quote.transactionRequest.data,
          value: BigInt(quote.transactionRequest.value),
        };

        const swapFee = await chain.estimateFee(network, swapRequest, fromAddress);
        const swapNonce = await chain.getPendingNonce(network, fromAddress);

        const response = await chain.signAndBroadcast(network, privateKey, {
          ...swapRequest,
          nonce: swapNonce,
          gasLimit: swapFee.gasLimit,
          ...(swapFee.maxFeePerGas
            ? { maxFeePerGas: swapFee.maxFeePerGas, maxPriorityFeePerGas: swapFee.maxPriorityFeePerGas ?? 0n }
            : { gasPrice: swapFee.gasPrice ?? 0n }),
        });
        await waitForReceipt(network, response.hash);
        return response.hash;
      }),
    );

    const tokenAfter = await chain.getTokenBalance(network, quote.tokenAddress, fromAddress);
    const actualReceived = tokenAfter - tokenBefore;

    let profitTxHash: string | null = null;
    let creditedRaw = actualReceived;

    if (identity.kind === 'client' && actualReceived > 0n) {
      const settings = await getBuySettings();
      if (settings.buyMarkupBps > 0 && settings.profitAddress) {
        const profitCut = (actualReceived * BigInt(settings.buyMarkupBps)) / 10_000n;
        if (profitCut > 0n) {
          profitTxHash = await withChainLock(network.chainId, () =>
            withSigner(identity, async (privateKey) => {
              const iface = new Contract(quote.tokenAddress, [
                'function transfer(address to, uint256 amount) returns (bool)',
              ]).interface;
              const transferRequest = {
                to: getAddress(quote.tokenAddress),
                data: iface.encodeFunctionData('transfer', [settings.profitAddress!, profitCut]),
                value: 0n,
              };
              const fee = await chain.estimateFee(network, transferRequest, fromAddress);
              const nonce = await chain.getPendingNonce(network, fromAddress);

              const response = await chain.signAndBroadcast(network, privateKey, {
                ...transferRequest,
                nonce,
                gasLimit: fee.gasLimit,
                ...(fee.maxFeePerGas
                  ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n }
                  : { gasPrice: fee.gasPrice ?? 0n }),
              });
              await waitForReceipt(network, response.hash);
              return response.hash;
            }),
          );
          creditedRaw = actualReceived - profitCut;

          await recordAudit({
            actorType: 'system',
            action: 'buy.markup.skim',
            entity: 'TransactionRecord',
            entityId: record.id,
            after: {
              clientId: identity.client.id,
              tokenAddress: quote.tokenAddress,
              profitCutRaw: profitCut.toString(),
              profitTxHash,
              profitAddress: settings.profitAddress,
            },
          });
        }
      }
    }

    // A customer's purchase lands in their own deposit wallet, not the
    // shared custodial wallet the send feature actually spends from — left
    // there, it would just sit unreachable by the rest of the app. Sweep it
    // across immediately so it becomes part of the balance flash-sends draw
    // from, the same on-chain transfer as the markup skim just above, only
    // addressed to the custodial wallet instead of the profit address. Only
    // meaningful when this deployment runs a custodial wallet at all —
    // skipped, not failed, on a buy-only deployment with no shared wallet.
    if (identity.kind === 'client' && creditedRaw > 0n && serverWallet.isCustodial()) {
      const custodialAddress = serverWallet.address();
      const sweepTxHash = await withChainLock(network.chainId, () =>
        withSigner(identity, async (privateKey) => {
          const iface = new Contract(quote.tokenAddress, [
            'function transfer(address to, uint256 amount) returns (bool)',
          ]).interface;
          const sweepRequest = {
            to: getAddress(quote.tokenAddress),
            data: iface.encodeFunctionData('transfer', [custodialAddress, creditedRaw]),
            value: 0n,
          };
          const fee = await chain.estimateFee(network, sweepRequest, fromAddress);
          const nonce = await chain.getPendingNonce(network, fromAddress);

          const response = await chain.signAndBroadcast(network, privateKey, {
            ...sweepRequest,
            nonce,
            gasLimit: fee.gasLimit,
            ...(fee.maxFeePerGas
              ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n }
              : { gasPrice: fee.gasPrice ?? 0n }),
          });
          await waitForReceipt(network, response.hash);
          return response.hash;
        }),
      );

      await recordAudit({
        actorType: 'system',
        action: 'buy.sweep',
        entity: 'TransactionRecord',
        entityId: record.id,
        after: {
          clientId: identity.client.id,
          tokenAddress: quote.tokenAddress,
          sweptRaw: creditedRaw.toString(),
          sweepTxHash,
          custodialAddress,
        },
      });
    }

    const updated = await prisma.transactionRecord.update({
      where: { id: record.id },
      data: {
        status: 'CONFIRMED',
        txHash: swapHash,
        amountRaw: creditedRaw.toString(),
        amountDisplay: formatAmount(creditedRaw, quote.tokenDecimals),
        confirmedAt: new Date(),
        broadcastAt: new Date(),
      },
    });

    await recordAudit({
      actorType: identity.kind === 'client' ? 'client' : 'admin',
      action: 'buy.execute',
      entity: 'TransactionRecord',
      entityId: updated.id,
      after: {
        tokenAddress: quote.tokenAddress,
        spendAssetId: quote.spendAssetId,
        amountInRaw: quote.amountInRaw.toString(),
        actualReceivedRaw: actualReceived.toString(),
        creditedRaw: creditedRaw.toString(),
        txHash: swapHash,
      },
    });

    return {
      id: updated.id,
      txHash: swapHash,
      tokenAddress: quote.tokenAddress,
      tokenSymbol: quote.tokenSymbol,
      creditedDisplay: formatAmount(creditedRaw, quote.tokenDecimals),
      explorerUrl: `${network.explorerUrl}/tx/${swapHash}`,
    };
  } catch (err) {
    const appError =
      err instanceof AppError
        ? err
        : new AppError(502, 'BUY_FAILED', (err as Error)?.message ?? 'The purchase failed.');

    await prisma.transactionRecord.update({
      where: { id: record.id },
      data: { status: 'FAILED', errorCode: appError.code, errorMessage: appError.message },
    });

    logger.warn({ err: appError, quoteRef }, 'Buy execution failed');
    throw appError;
  }
}
