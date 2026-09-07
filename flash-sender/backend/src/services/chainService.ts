import {
  Contract,
  FallbackProvider,
  JsonRpcProvider,
  Network as EthersNetwork,
  Wallet,
  getAddress,
  isAddress,
  type TransactionReceipt,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';
import type { Asset, Network } from '@prisma/client';
import { AppError } from '../lib/errors';
import { decodeUrlList } from '../lib/columns';

/**
 * Blockchain access for custodial sending.
 *
 * Mirrors the desktop client's blockchain service: every value shown or acted
 * on comes from a real RPC call, and nothing here synthesises a balance, a
 * fee, a hash or a confirmation.
 */

export const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

export type AssetWithNetwork = Asset & { network: Network };

const providerCache = new Map<string, JsonRpcProvider | FallbackProvider>();
const rawProviderCache = new Map<string, JsonRpcProvider[]>();

const cacheKey = (network: Network) => `${network.chainId}:${network.rpcUrlsRaw}`;

export function getProvider(network: Network): JsonRpcProvider | FallbackProvider {
  const key = cacheKey(network);
  const cached = providerCache.get(key);
  if (cached) return cached;

  const urls = decodeUrlList(network.rpcUrlsRaw);

  if (!urls.length) {
    throw new AppError(
      500,
      'NO_RPC_CONFIGURED',
      `No RPC endpoint is configured for ${network.name}.`,
    );
  }

  // A concrete Network so ethers pins the chain id and rejects an endpoint
  // that disagrees, rather than silently auto-detecting.
  const staticNetwork = new EthersNetwork(network.key, BigInt(network.chainId));

  const providers = urls.map(
    (url) => new JsonRpcProvider(url, staticNetwork, { staticNetwork: true, batchMaxCount: 1 }),
  );

  const provider =
    providers.length === 1
      ? providers[0]!
      : new FallbackProvider(
          providers.map((p, index) => ({ provider: p, priority: index + 1, weight: 1 })),
          staticNetwork,
          { quorum: 1 },
        );

  providerCache.set(key, provider);
  rawProviderCache.set(key, providers);
  return provider;
}

/**
 * Asks the node directly what chain it is on, via raw `eth_chainId`.
 *
 * This deliberately bypasses `provider.getNetwork()`: providers here are
 * built with `staticNetwork`, which makes ethers *assume* the configured
 * chain id rather than look it up — so getNetwork() would hand our own
 * configuration back and any comparison against it would be vacuously true.
 */
async function probeChainId(network: Network): Promise<number> {
  getProvider(network);
  const raws = rawProviderCache.get(cacheKey(network)) ?? [];

  let lastError: unknown;

  for (const provider of raws) {
    try {
      const hex: string = await provider.send('eth_chainId', []);
      return Number(BigInt(hex));
    } catch (err) {
      lastError = err;
    }
  }

  throw new AppError(
    502,
    'RPC_UNREACHABLE',
    `Could not reach any RPC endpoint for ${network.name}. ` +
      (lastError instanceof Error ? lastError.message.slice(0, 160) : ''),
  );
}

/** Confirms the endpoint really is the chain we think it is. Aborts on mismatch. */
export async function assertChainId(network: Network): Promise<number> {
  const reported = await probeChainId(network);

  if (reported !== network.chainId) {
    throw new AppError(
      502,
      'NETWORK_MISMATCH',
      `${network.name} is configured as chain ${network.chainId}, but its RPC endpoint reports ` +
        `chain ${reported}. Sending was stopped.`,
    );
  }

  return reported;
}

export async function getNativeBalance(network: Network, addr: string): Promise<bigint> {
  return getProvider(network).getBalance(getAddress(addr));
}

export async function getTokenBalance(
  network: Network,
  contractAddress: string,
  owner: string,
): Promise<bigint> {
  const contract = new Contract(getAddress(contractAddress), ERC20_ABI, getProvider(network));

  try {
    return await contract.balanceOf!(getAddress(owner));
  } catch {
    throw new AppError(
      502,
      'NOT_A_TOKEN_CONTRACT',
      `No token contract responded at ${contractAddress} on ${network.name}.`,
    );
  }
}

export async function getBalanceFor(asset: AssetWithNetwork, addr: string): Promise<bigint> {
  return asset.isNative
    ? getNativeBalance(asset.network, addr)
    : getTokenBalance(asset.network, asset.contractAddress!, addr);
}

/**
 * Verifies the configured contract is a real token with the decimals claimed.
 *
 * A wrong `decimals` is silent and catastrophic — configuring 18 against a
 * 6-decimal token would move a million times the intended amount — so the
 * on-chain value wins and a mismatch is a hard stop.
 */
export async function verifyTokenContract(
  network: Network,
  contractAddress: string,
  expectedDecimals: number,
  expectedSymbol?: string,
): Promise<{ warnings: string[] }> {
  const provider = getProvider(network);
  const addr = getAddress(contractAddress);
  const warnings: string[] = [];

  if ((await provider.getCode(addr)) === '0x') {
    throw new AppError(
      502,
      'NOT_A_CONTRACT',
      `There is no contract deployed at ${addr} on ${network.name}. This asset is misconfigured.`,
    );
  }

  const contract = new Contract(addr, ERC20_ABI, provider);

  let onChainDecimals: number;
  try {
    onChainDecimals = Number(await contract.decimals!());
  } catch {
    throw new AppError(
      502,
      'NOT_A_TOKEN_CONTRACT',
      `The contract at ${addr} does not expose a standard decimals() function.`,
    );
  }

  if (onChainDecimals !== expectedDecimals) {
    throw new AppError(
      502,
      'DECIMALS_MISMATCH',
      `The token contract at ${addr} reports ${onChainDecimals} decimals, but this asset is ` +
        `configured with ${expectedDecimals}. Sending was stopped — that difference would change ` +
        `the amount transferred by a factor of ${10 ** Math.abs(onChainDecimals - expectedDecimals)}.`,
    );
  }

  try {
    const onChainSymbol: string = await contract.symbol!();
    if (expectedSymbol && onChainSymbol.toUpperCase() !== expectedSymbol.toUpperCase()) {
      warnings.push(
        `The contract calls itself "${onChainSymbol}" but this asset is configured as ` +
          `"${expectedSymbol}".`,
      );
    }
  } catch {
    warnings.push('This contract does not expose a symbol() function.');
  }

  return { warnings };
}

/** Builds the unsigned transaction. Native → value transfer; token → transfer(). */
export function buildTransferRequest(
  asset: AssetWithNetwork,
  to: string,
  amountRaw: bigint,
): TransactionRequest {
  const recipient = getAddress(to);

  if (asset.isNative) {
    return { to: recipient, value: amountRaw };
  }

  if (!asset.contractAddress || !isAddress(asset.contractAddress)) {
    throw new AppError(
      500,
      'INVALID_CONTRACT',
      `${asset.symbol} is configured as a token but has no valid contract address.`,
    );
  }

  const iface = new Contract(asset.contractAddress, ERC20_ABI).interface;

  return {
    to: getAddress(asset.contractAddress),
    data: iface.encodeFunctionData('transfer', [recipient, amountRaw]),
    value: 0n,
  };
}

export interface FeeEstimate {
  gasLimit: bigint;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  gasPrice: bigint | null;
  totalFee: bigint;
}

/**
 * Estimates the fee.
 *
 * `eth_estimateGas` executes the transfer against current state, so a revert
 * (paused token, blocked address, insufficient balance) surfaces here —
 * before anything is signed — rather than as a failed on-chain transaction
 * that still costs gas.
 */
export async function estimateFee(
  network: Network,
  request: TransactionRequest,
  from: string,
): Promise<FeeEstimate> {
  const provider = getProvider(network);

  let gasLimit: bigint;
  try {
    gasLimit = await provider.estimateGas({ ...request, from: getAddress(from) });
  } catch (err) {
    const message = (err as { shortMessage?: string; message?: string })?.shortMessage ??
      (err as Error)?.message ?? '';

    if (/insufficient funds/i.test(message)) {
      throw new AppError(
        400,
        'INSUFFICIENT_NATIVE_FOR_GAS',
        `The sending wallet does not hold enough ${network.nativeSymbol} to pay the network fee.`,
      );
    }
    if (/transfer amount exceeds balance/i.test(message)) {
      throw new AppError(
        400,
        'INSUFFICIENT_TOKEN_BALANCE',
        'The token contract rejected the transfer: the wallet does not hold that much.',
      );
    }
    throw new AppError(
      400,
      'EXECUTION_REVERTED',
      `The transaction would fail: ${message.slice(0, 200) || 'the contract reverted.'}`,
    );
  }

  // 20% headroom absorbs state drift between estimation and inclusion.
  gasLimit = (gasLimit * 120n) / 100n;

  const feeData = await provider.getFeeData();

  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    return {
      gasLimit,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      gasPrice: null,
      totalFee: gasLimit * feeData.maxFeePerGas,
    };
  }

  if (!feeData.gasPrice) {
    throw new AppError(
      502,
      'FEE_UNAVAILABLE',
      `${network.name} did not return a gas price, so the fee cannot be estimated. Sending was ` +
        'stopped rather than guessing.',
    );
  }

  return {
    gasLimit,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    gasPrice: feeData.gasPrice,
    totalFee: gasLimit * feeData.gasPrice,
  };
}

export async function getPendingNonce(network: Network, addr: string): Promise<number> {
  return getProvider(network).getTransactionCount(getAddress(addr), 'pending');
}

/**
 * Signs and broadcasts.
 *
 * The returned hash is the one the network computed from the signed bytes.
 * This application has no other source for a transaction hash.
 */
export async function signAndBroadcast(
  network: Network,
  privateKey: string,
  request: TransactionRequest,
): Promise<TransactionResponse> {
  const wallet = new Wallet(privateKey, getProvider(network));

  // EIP-155: the chain id is part of the signed payload, so a signature for
  // one chain cannot be replayed on another.
  return wallet.sendTransaction({ ...request, chainId: network.chainId });
}

export async function getReceipt(
  network: Network,
  txHash: string,
): Promise<TransactionReceipt | null> {
  return getProvider(network).getTransactionReceipt(txHash);
}
