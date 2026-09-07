import {
  Contract,
  FallbackProvider,
  JsonRpcProvider,
  Network,
  Wallet,
  formatUnits,
  getAddress,
  isAddress,
  type TransactionReceipt,
  type TransactionRequest,
  type TransactionResponse,
} from 'ethers';
import type { AssetConfig, NetworkConfig } from '../../shared/types';
import { AppError, describeRpcError } from '../lib/errors';
import { formatAmount } from '../lib/amount';

/**
 * Blockchain access layer.
 *
 * Every value the UI shows about the chain originates here, from a real RPC
 * call. Nothing in this file synthesises a balance, a fee, a hash or a
 * confirmation — where the chain cannot tell us something, the caller gets an
 * error rather than a placeholder.
 */

/** The subset of ERC-20 / BEP-20 this application uses. */
export const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
] as const;

const providerCache = new Map<string, JsonRpcProvider | FallbackProvider>();

/**
 * The underlying single-endpoint providers, kept alongside the cached
 * (possibly Fallback-wrapped) provider.
 *
 * These are needed because chain-id verification must bypass the static
 * network pin — see `assertChainId`.
 */
const rawProviderCache = new Map<string, JsonRpcProvider[]>();

function providerKey(network: NetworkConfig) {
  return `${network.chainId}:${network.rpcUrls.join('|')}`;
}

/**
 * Builds a provider pinned to the network's declared chain id.
 *
 * Pinning matters: ethers will then reject any response from an endpoint whose
 * `eth_chainId` disagrees, which is the guard against a misconfigured or
 * swapped RPC URL causing a transaction to be signed for the wrong chain.
 */
export function getProvider(network: NetworkConfig): JsonRpcProvider | FallbackProvider {
  const key = providerKey(network);
  const cached = providerCache.get(key);
  if (cached) return cached;

  if (!network.rpcUrls.length) {
    throw new AppError(
      'NO_RPC_CONFIGURED',
      `No RPC endpoint is configured for ${network.name}. Add one in the admin dashboard.`,
    );
  }

  // A concrete Network instance, so ethers treats the chain id as fixed and
  // rejects any endpoint that disagrees rather than auto-detecting.
  const staticNetwork = new Network(network.key, BigInt(network.chainId));

  const providers = network.rpcUrls.map(
    (url) =>
      new JsonRpcProvider(url, staticNetwork, {
        staticNetwork: true,
        batchMaxCount: 1,
      }),
  );

  // With more than one endpoint, fall back automatically when one is down.
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

export function clearProviderCache() {
  for (const provider of providerCache.values()) provider.destroy?.();
  providerCache.clear();
  rawProviderCache.clear();
}

/**
 * Asks the node directly what chain it is on, via a raw `eth_chainId` call.
 *
 * This deliberately does NOT go through `provider.getNetwork()`. Providers here
 * are constructed with `staticNetwork`, which makes ethers *assume* the
 * configured chain id and skip the lookup entirely — so `getNetwork()` would
 * return our own configuration back to us and any comparison against it would
 * be vacuously true. Pinning is still the right behaviour for ordinary calls
 * (it stops a mid-session chain swap), but verification has to bypass it, or
 * the mismatch guard verifies nothing.
 */
async function probeChainId(network: NetworkConfig): Promise<number> {
  getProvider(network); // populate the cache
  const raws = rawProviderCache.get(providerKey(network)) ?? [];

  let lastError: unknown;

  for (const provider of raws) {
    try {
      const hex: string = await provider.send('eth_chainId', []);
      return Number(BigInt(hex));
    } catch (err) {
      lastError = err;
    }
  }

  const described = describeRpcError(lastError);
  throw new AppError(described.code, described.message, described.detail);
}

/**
 * Confirms the endpoint really is the chain we think it is.
 *
 * Called before every send. A mismatch here aborts the transaction: signing
 * for the wrong chain id is how funds get sent into the void.
 */
export async function assertChainId(network: NetworkConfig): Promise<number> {
  const reported = await probeChainId(network);

  if (reported !== network.chainId) {
    throw new AppError(
      'NETWORK_MISMATCH',
      `${network.name} is configured as chain ${network.chainId}, but its RPC endpoint reports ` +
        `chain ${reported}. Sending was stopped. Correct the network configuration before ` +
        'trying again.',
    );
  }

  return reported;
}

export async function getChainStatus(network: NetworkConfig) {
  try {
    const [reportedChainId, blockNumber] = await Promise.all([
      probeChainId(network),
      getProvider(network).getBlockNumber(),
    ]);

    const matches = reportedChainId === network.chainId;

    return {
      connected: matches,
      chainId: network.chainId,
      reportedChainId,
      blockNumber,
      rpcUrl: network.rpcUrls[0] ?? null,
      error: matches
        ? null
        : `RPC endpoint reports chain ${reportedChainId}, expected ${network.chainId}.`,
    };
  } catch (err) {
    const described = describeRpcError(err);
    return {
      connected: false,
      chainId: network.chainId,
      reportedChainId: null,
      blockNumber: null,
      rpcUrl: network.rpcUrls[0] ?? null,
      error: described.message,
    };
  }
}

/** Native coin balance in base units. */
export async function getNativeBalance(network: NetworkConfig, address: string): Promise<bigint> {
  try {
    return await getProvider(network).getBalance(getAddress(address));
  } catch (err) {
    const described = describeRpcError(err);
    throw new AppError(described.code, described.message, described.detail);
  }
}

/** Token balance in base units, read from the contract itself. */
export async function getTokenBalance(
  network: NetworkConfig,
  contractAddress: string,
  owner: string,
): Promise<bigint> {
  const contract = new Contract(getAddress(contractAddress), ERC20_ABI, getProvider(network));

  try {
    return await contract.balanceOf!(getAddress(owner));
  } catch (err) {
    const described = describeRpcError(err);
    throw new AppError(
      described.code === 'EXECUTION_REVERTED' ? 'NOT_A_TOKEN_CONTRACT' : described.code,
      described.code === 'EXECUTION_REVERTED'
        ? `No token contract responded at ${contractAddress} on ${network.name}. Check the ` +
          'contract address configured for this asset.'
        : described.message,
      described.detail,
    );
  }
}

export async function getBalanceFor(
  asset: AssetConfig,
  address: string,
): Promise<{ raw: bigint; formatted: string }> {
  const raw = asset.isNative
    ? await getNativeBalance(asset.network, address)
    : await getTokenBalance(asset.network, asset.contractAddress!, address);

  return { raw, formatted: formatAmount(raw, asset.decimals) };
}

/**
 * Verifies that the configured contract is actually a token contract with the
 * decimals the backend claims.
 *
 * A wrong `decimals` is silent and catastrophic — sending "1.0" against a
 * contract configured as 18 decimals but actually 6 would move a million
 * times the intended amount. So the on-chain value wins, and a mismatch is a
 * hard stop rather than a warning.
 */
export async function verifyTokenContract(
  network: NetworkConfig,
  contractAddress: string,
  expectedDecimals: number,
  expectedSymbol?: string,
): Promise<{ decimals: number; symbol: string; warnings: string[] }> {
  const provider = getProvider(network);
  const address = getAddress(contractAddress);

  const code = await provider.getCode(address);
  if (code === '0x') {
    throw new AppError(
      'NOT_A_CONTRACT',
      `There is no contract deployed at ${address} on ${network.name}. This asset is ` +
        'misconfigured — do not send to it. Correct the contract address in the admin dashboard.',
    );
  }

  const contract = new Contract(address, ERC20_ABI, provider);
  const warnings: string[] = [];

  let onChainDecimals: number;
  try {
    onChainDecimals = Number(await contract.decimals!());
  } catch {
    throw new AppError(
      'NOT_A_TOKEN_CONTRACT',
      `The contract at ${address} does not expose a standard "decimals()" function, so it ` +
        'cannot be treated as a token. Check the configured contract address.',
    );
  }

  if (onChainDecimals !== expectedDecimals) {
    throw new AppError(
      'DECIMALS_MISMATCH',
      `The token contract at ${address} reports ${onChainDecimals} decimals, but this asset is ` +
        `configured with ${expectedDecimals}. Sending was stopped, because that difference would ` +
        `change the amount transferred by a factor of ${10 ** Math.abs(onChainDecimals - expectedDecimals)}. ` +
        'Correct the decimals in the admin dashboard.',
    );
  }

  let onChainSymbol = expectedSymbol ?? '';
  try {
    onChainSymbol = await contract.symbol!();
    if (expectedSymbol && onChainSymbol.toUpperCase() !== expectedSymbol.toUpperCase()) {
      warnings.push(
        `The contract calls itself "${onChainSymbol}" but this asset is configured as ` +
          `"${expectedSymbol}". Confirm you are sending the token you intend to.`,
      );
    }
  } catch {
    warnings.push('This contract does not expose a symbol() function.');
  }

  return { decimals: onChainDecimals, symbol: onChainSymbol, warnings };
}

/** Builds the unsigned transaction for a transfer. */
export function buildTransferRequest(
  asset: AssetConfig,
  to: string,
  amountRaw: bigint,
): TransactionRequest {
  const recipient = getAddress(to);

  if (asset.isNative) {
    // A plain value transfer of the network's own coin.
    return { to: recipient, value: amountRaw };
  }

  if (!asset.contractAddress || !isAddress(asset.contractAddress)) {
    throw new AppError(
      'INVALID_CONTRACT',
      `${asset.symbol} is configured as a token but has no valid contract address. Sending was ` +
        'stopped.',
    );
  }

  // Standard ERC-20 / BEP-20 transfer(address,uint256).
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
  /** gasLimit × the price actually offered. */
  totalFee: bigint;
}

/**
 * Estimates the fee for a prepared request.
 *
 * `eth_estimateGas` executes the transaction against current state, so a
 * revert (paused token, blocked address, insufficient balance) surfaces here
 * — before anything is signed — rather than as a failed on-chain transaction
 * that still costs the user gas.
 */
export async function estimateFee(
  network: NetworkConfig,
  request: TransactionRequest,
  from: string,
): Promise<FeeEstimate> {
  const provider = getProvider(network);

  let gasLimit: bigint;
  try {
    gasLimit = await provider.estimateGas({ ...request, from: getAddress(from) });
  } catch (err) {
    const described = describeRpcError(err);
    throw new AppError(described.code, described.message, described.detail);
  }

  // A 20% headroom absorbs state drift between estimation and inclusion.
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
      'FEE_UNAVAILABLE',
      `${network.name} did not return a gas price, so the network fee cannot be estimated. ` +
        'Sending was stopped rather than guessing a fee.',
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

export async function getTransactionCount(
  network: NetworkConfig,
  address: string,
): Promise<number> {
  return getProvider(network).getTransactionCount(getAddress(address), 'pending');
}

/**
 * Signs and broadcasts.
 *
 * Returns the node's own response. The hash on it is the hash the network
 * computed from the signed bytes — this application has no other source for
 * a transaction hash, and never invents one.
 */
export async function signAndBroadcast(
  network: NetworkConfig,
  privateKey: string,
  request: TransactionRequest,
): Promise<TransactionResponse> {
  const provider = getProvider(network);
  const wallet = new Wallet(privateKey, provider);

  // EIP-155: the chain id is part of the signed payload, so a signature for
  // one chain cannot be replayed on another.
  const populated: TransactionRequest = { ...request, chainId: network.chainId };

  try {
    return await wallet.sendTransaction(populated);
  } catch (err) {
    const described = describeRpcError(err);
    throw new AppError(described.code, described.message, described.detail);
  }
}

/**
 * Waits for a receipt.
 *
 * `status === 1` is the only thing that counts as success. `status === 0`
 * means the transaction was mined but reverted — it is on-chain, it cost gas,
 * and it did *not* move the tokens; reporting that as anything other than a
 * failure would be a lie.
 */
export async function waitForReceipt(
  network: NetworkConfig,
  txHash: string,
  confirmations: number,
  timeoutMs: number,
): Promise<TransactionReceipt | null> {
  const provider = getProvider(network);

  try {
    return await provider.waitForTransaction(txHash, confirmations, timeoutMs);
  } catch (err) {
    const described = describeRpcError(err);
    throw new AppError(described.code, described.message, described.detail);
  }
}

export async function getReceipt(
  network: NetworkConfig,
  txHash: string,
): Promise<TransactionReceipt | null> {
  return getProvider(network).getTransactionReceipt(txHash);
}

export const formatNative = (value: bigint, network: NetworkConfig) =>
  formatUnits(value, network.nativeDecimals);
