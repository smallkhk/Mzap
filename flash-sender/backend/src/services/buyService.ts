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
import {
  ERC20_APPROVE_ABI,
  PANCAKE_V2_ROUTER,
  PANCAKE_V2_ROUTER_ABI,
  WRAPPED_NATIVE,
} from '../lib/pancakeswap';

/**
 * The buy / "Generate tokens" pipeline.
 *
 * Same two-phase shape as the send pipeline for the same reason: `prepare`
 * reads real state and quotes real routes, nothing is signed; `confirm`
 * re-verifies and executes exactly the route that was quoted, referenced
 * by an opaque id rather than re-submitted, so a tampered client cannot
 * change what gets bought between the screen and the signature.
 *
 * Execution is PancakeSwap only, for now. 1inch and LI.FI are queried as
 * additional, genuinely-fetched quote sources so the buyer sees a real
 * price comparison — but only PancakeSwap's route is actually signed and
 * broadcast. Routing a signed transaction through a third-party
 * aggregator's returned calldata is a meaningfully larger trust and
 * verification surface than an on-chain router call this app controls
 * completely, and it is not yet built. See docs/BUY.md.
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

interface QuoteSourceResult {
  source: 'pancakeswap' | '1inch' | 'lifi';
  amountOutRaw: bigint;
}

/** Candidate PancakeSwap V2 paths: direct, and via wrapped native if that isn't already an endpoint. */
function candidatePaths(chainId: number, tokenIn: string, tokenOut: string): string[][] {
  const wnative = WRAPPED_NATIVE[chainId];
  const paths = [[tokenIn, tokenOut]];
  if (wnative && tokenIn !== wnative && tokenOut !== wnative) {
    paths.push([tokenIn, wnative, tokenOut]);
  }
  return paths;
}

async function quotePancakeSwap(
  network: Network,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<{ amountOutRaw: bigint; path: string[] } | null> {
  const routerAddress = PANCAKE_V2_ROUTER[network.chainId];
  if (!routerAddress) return null;

  const provider = chain.getProvider(network);
  const router = new Contract(routerAddress, PANCAKE_V2_ROUTER_ABI, provider);

  let best: { amountOutRaw: bigint; path: string[] } | null = null;

  for (const path of candidatePaths(network.chainId, tokenIn, tokenOut)) {
    try {
      const amounts: bigint[] = await router.getAmountsOut!(amountIn, path);
      const out = amounts[amounts.length - 1]!;
      if (!best || out > best.amountOutRaw) best = { amountOutRaw: out, path };
    } catch {
      // No pair on this path, or insufficient liquidity. Try the next one.
    }
  }

  return best;
}

/** 1inch only indexes BSC mainnet, and only when an API key is configured. */
async function quote1inch(
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  apiKey: string | undefined,
): Promise<QuoteSourceResult | null> {
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
    if (!amountOutRaw) return null;

    return { source: '1inch', amountOutRaw: BigInt(amountOutRaw) };
  } catch {
    return null;
  }
}

/** LI.FI's basic quote endpoint works without a key; a key only raises rate limits. */
async function quoteLifi(
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fromAddress: string,
  apiKey: string | undefined,
): Promise<QuoteSourceResult | null> {
  try {
    const params = new URLSearchParams({
      fromChain: String(chainId),
      toChain: String(chainId),
      fromToken: tokenIn,
      toToken: tokenOut,
      fromAddress,
      fromAmount: amountIn.toString(),
    });

    const res = await fetch(`https://li.quest/v1/quote?${params.toString()}`, {
      headers: { Accept: 'application/json', ...(apiKey ? { 'x-lifi-api-key': apiKey } : {}) },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;

    const body = (await res.json()) as { estimate?: { toAmount?: string } };
    if (!body.estimate?.toAmount) return null;

    return { source: 'lifi', amountOutRaw: BigInt(body.estimate.toAmount) };
  } catch {
    return null;
  }
}

// The conventional placeholder both 1inch and LI.FI use for "the chain's
// native coin" where an ERC-20 address is otherwise expected. Never
// dereferenced on-chain — it only appears in these two APIs' request URLs.
const NATIVE_PSEUDO_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

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
  path: string[];
  amountOutRaw: bigint;
  amountOutMin: bigint;
  createdAt: number;
}

const quotes = new Map<string, StoredBuyQuote>();
const QUOTE_TTL_MS = 2 * 60_000; // DEX prices move faster than a fixed send fee; a shorter window than sendService's.
const SLIPPAGE_BPS = 100n; // 1% floor under the quoted output, to absorb normal price movement before broadcast.

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

  const fromAddress = await resolveFromAddress(identity);
  await chain.assertChainId(spendAsset.network);

  const amountInRaw = parseAmount(input.amountIn, spendAsset.decimals, spendAsset.symbol);
  const tokenAddress = getAddress(input.tokenAddress);

  // Read the target token live — never trust a pasted address without
  // confirming it is a real token contract, same rule the send pipeline
  // applies to configured assets.
  const provider = chain.getProvider(spendAsset.network);
  if ((await provider.getCode(tokenAddress)) === '0x') {
    throw badRequest('NOT_A_CONTRACT', `There is no contract deployed at ${tokenAddress}.`);
  }
  const tokenContract = new Contract(tokenAddress, ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'], provider);

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
    : await chain.getTokenBalance(spendAsset.network, spendAsset.contractAddress!, fromAddress);

  if (spendBalance < amountInRaw) {
    throw badRequest(
      'INSUFFICIENT_BALANCE',
      `This wallet holds ${formatAmount(spendBalance, spendAsset.decimals)} ${spendAsset.symbol}, ` +
        `less than the ${formatAmount(amountInRaw, spendAsset.decimals)} requested.`,
    );
  }

  const wnative = WRAPPED_NATIVE[spendAsset.network.chainId];
  const spendPathAddress = spendAsset.isNative ? wnative : getAddress(spendAsset.contractAddress!);
  if (!spendPathAddress) {
    throw badRequest(
      'UNSUPPORTED_NETWORK',
      `Buying is not supported on ${spendAsset.network.name} yet — no router is configured.`,
    );
  }

  const [pancake, oneInch, lifi, buySettings] = await Promise.all([
    quotePancakeSwap(spendAsset.network, spendPathAddress, tokenAddress, amountInRaw),
    quote1inch(
      spendAsset.network.chainId,
      spendAsset.isNative ? NATIVE_PSEUDO_ADDRESS : spendPathAddress,
      tokenAddress,
      amountInRaw,
      config.ONEINCH_API_KEY,
    ),
    quoteLifi(
      spendAsset.network.chainId,
      spendAsset.isNative ? NATIVE_PSEUDO_ADDRESS : spendPathAddress,
      tokenAddress,
      amountInRaw,
      fromAddress,
      config.LIFI_API_KEY,
    ),
    getBuySettings(),
  ]);

  if (!pancake) {
    throw badRequest(
      'NO_ROUTE_FOUND',
      `No PancakeSwap route was found from ${spendAsset.symbol} to this token. It may have no ` +
        `liquidity on ${spendAsset.network.name}.`,
    );
  }

  const amountOutMin = pancake.amountOutRaw - (pancake.amountOutRaw * SLIPPAGE_BPS) / 10_000n;

  const quoteRef = crypto.randomUUID();
  quotes.set(quoteRef, {
    identity,
    chainId: spendAsset.network.chainId,
    networkKey: spendAsset.network.key,
    spendAssetId: spendAsset.assetId,
    spendIsNative: spendAsset.isNative,
    spendContractAddress: spendAsset.contractAddress,
    spendDecimals: spendAsset.decimals,
    spendSymbol: spendAsset.symbol,
    amountInRaw,
    tokenAddress,
    tokenDecimals,
    tokenSymbol,
    path: pancake.path,
    amountOutRaw: pancake.amountOutRaw,
    amountOutMin,
    createdAt: Date.now(),
  });
  reapQuotes();

  const markupBps = identity.kind === 'client' ? buySettings.buyMarkupBps : 0;
  const buyerAmountRaw = pancake.amountOutRaw - (pancake.amountOutRaw * BigInt(markupBps)) / 10_000n;

  const comparisons: { source: string; amountOutDisplay: string }[] = [
    { source: 'pancakeswap', amountOutDisplay: formatAmount(pancake.amountOutRaw, tokenDecimals) },
  ];
  if (oneInch) {
    comparisons.push({ source: '1inch', amountOutDisplay: formatAmount(oneInch.amountOutRaw, tokenDecimals) });
  }
  if (lifi) {
    comparisons.push({ source: 'lifi', amountOutDisplay: formatAmount(lifi.amountOutRaw, tokenDecimals) });
  }

  return {
    quoteRef,
    tokenAddress,
    tokenSymbol,
    tokenDecimals,
    spendSymbol: spendAsset.symbol,
    amountInDisplay: formatAmount(amountInRaw, spendAsset.decimals),
    marketAmountOutDisplay: formatAmount(pancake.amountOutRaw, tokenDecimals),
    buyerAmountOutDisplay: formatAmount(buyerAmountRaw, tokenDecimals),
    markupBps,
    executesVia: 'pancakeswap' as const,
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

  const routerAddress = PANCAKE_V2_ROUTER[network.chainId]!;
  const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes

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
    // estimated fresh right before signing (with the same 20% headroom
    // `chain.estimateFee` applies everywhere else), not left to an
    // implicit default — a router call is more failure-prone to
    // under-estimate than a plain transfer, so guessing here is exactly
    // the wrong place to save a request.
    const swapHash = await withChainLock(network.chainId, () =>
      withSigner(identity, async (privateKey) => {
        // ERC-20 spend needs an approval before the router can pull funds.
        if (!quote.spendIsNative) {
          const allowanceContract = new Contract(
            quote.spendContractAddress!,
            ERC20_APPROVE_ABI,
            chain.getProvider(network),
          );
          const currentAllowance: bigint = await allowanceContract.allowance!(fromAddress, routerAddress);

          if (currentAllowance < quote.amountInRaw) {
            const approveIface = new Contract(quote.spendContractAddress!, ERC20_APPROVE_ABI).interface;
            const approveRequest = {
              to: getAddress(quote.spendContractAddress!),
              data: approveIface.encodeFunctionData('approve', [routerAddress, quote.amountInRaw]),
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
              after: { txHash: approveResponse.hash, spender: routerAddress },
            });
          }
        }

        const routerIface = new Contract(routerAddress, PANCAKE_V2_ROUTER_ABI).interface;

        const swapRequest = quote.spendIsNative
          ? {
              to: getAddress(routerAddress),
              data: routerIface.encodeFunctionData('swapExactETHForTokens', [
                quote.amountOutMin,
                quote.path,
                fromAddress,
                deadline,
              ]),
              value: quote.amountInRaw,
            }
          : {
              to: getAddress(routerAddress),
              data: routerIface.encodeFunctionData('swapExactTokensForTokens', [
                quote.amountInRaw,
                quote.amountOutMin,
                quote.path,
                fromAddress,
                deadline,
              ]),
              value: 0n,
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
