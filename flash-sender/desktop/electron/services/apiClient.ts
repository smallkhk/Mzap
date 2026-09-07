import type {
  AppConfig,
  AssetConfig,
  NetworkConfig,
  SigningMode,
  TransferQuote,
  TxState,
} from '../../shared/types';
import { AppError } from '../lib/errors';
import { getApiKey, getSettings } from './settings';

/**
 * Client for the configuration/ledger backend.
 *
 * Runs in the main process only. The API key is attached here and never
 * crosses into the renderer.
 *
 * Responses are treated as untrusted input: `normaliseAsset` re-validates
 * every field — including contract addresses and chain ids — before the data
 * is allowed anywhere near a transaction. A compromised or spoofed backend
 * still cannot hand this application a malformed address.
 */

const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(
  pathname: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const settings = await getSettings();

  if (!settings.apiBaseUrl) {
    throw new AppError(
      'BACKEND_NOT_CONFIGURED',
      'No backend address has been configured. Open Settings and enter your API URL and key.',
    );
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new AppError(
      'API_KEY_MISSING',
      'No backend API key has been configured. Open Settings and paste the key issued by your ' +
        'administrator.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${settings.apiBaseUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new AppError(
        'BACKEND_TIMEOUT',
        `The backend at ${settings.apiBaseUrl} did not respond within 15 seconds.`,
      );
    }
    throw new AppError(
      'BACKEND_UNREACHABLE',
      `Could not reach the backend at ${settings.apiBaseUrl}. Check the address in Settings and ` +
        'your internet connection.',
      err instanceof Error ? err.message : undefined,
    );
  } finally {
    clearTimeout(timeout);
  }

  // 401 means the key itself was not accepted. A 403 is a *authenticated*
  // refusal — most often a spending limit in custodial mode — and carries a
  // message that explains exactly what is missing, so it must fall through to
  // the generic handler below rather than being mislabelled as a bad key.
  if (response.status === 401) {
    throw new AppError(
      'API_KEY_REJECTED',
      'The backend rejected this application\'s API key. It may have been revoked — ask your ' +
        'administrator to issue a new one.',
    );
  }

  if (response.status === 429) {
    throw new AppError(
      'BACKEND_RATE_LIMITED',
      'The backend is rate-limiting this application. Wait a moment and try again.',
    );
  }

  if (!response.ok) {
    let message = `The backend returned HTTP ${response.status}.`;
    let code = 'BACKEND_ERROR';
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      /* keep the generic message */
    }
    throw new AppError(code, message);
  }

  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Re-validation of server-supplied configuration
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function normaliseNetwork(raw: any): NetworkConfig {
  if (!Number.isInteger(raw?.chainId) || raw.chainId <= 0) {
    throw new AppError(
      'CONFIG_INVALID',
      `The backend supplied network "${raw?.name ?? raw?.key}" with an invalid chain ID.`,
    );
  }

  const rpcUrls: string[] = Array.isArray(raw.rpcUrls) ? raw.rpcUrls.filter(Boolean) : [];
  if (!rpcUrls.length) {
    throw new AppError(
      'CONFIG_INVALID',
      `Network "${raw.name}" has no RPC endpoint configured, so it cannot be used.`,
    );
  }

  return {
    key: String(raw.key),
    name: String(raw.name),
    chainId: raw.chainId,
    rpcUrls,
    explorerUrl: String(raw.explorerUrl ?? '').replace(/\/+$/, ''),
    nativeSymbol: String(raw.nativeSymbol ?? ''),
    nativeName: String(raw.nativeName ?? raw.nativeSymbol ?? ''),
    nativeDecimals: Number.isInteger(raw.nativeDecimals) ? raw.nativeDecimals : 18,
    isTestnet: Boolean(raw.isTestnet),
  };
}

function normaliseAsset(raw: any): AssetConfig {
  const network = normaliseNetwork(raw.network);

  if (!Number.isInteger(raw.decimals) || raw.decimals < 0 || raw.decimals > 36) {
    throw new AppError(
      'CONFIG_INVALID',
      `Asset "${raw.symbol}" has invalid decimals (${raw.decimals}) and has been ignored.`,
    );
  }

  const isNative = Boolean(raw.isNative);
  const contractAddress = raw.contractAddress ? String(raw.contractAddress) : null;

  if (!isNative) {
    if (!contractAddress || !ADDRESS_RE.test(contractAddress)) {
      throw new AppError(
        'CONFIG_INVALID',
        `Token "${raw.symbol}" has a malformed contract address and cannot be used. Correct it ` +
          'in the admin dashboard.',
      );
    }
  }

  if (raw.chainId !== network.chainId) {
    throw new AppError(
      'CONFIG_INVALID',
      `Asset "${raw.symbol}" declares chain ${raw.chainId} but its network is chain ` +
        `${network.chainId}.`,
    );
  }

  return {
    id: String(raw.id),
    name: String(raw.name),
    symbol: String(raw.symbol),
    network,
    chainId: network.chainId,
    contractAddress: isNative ? null : contractAddress,
    decimals: raw.decimals,
    isNative,
    explorerUrl: String(raw.explorerUrl ?? network.explorerUrl).replace(/\/+$/, ''),
    logoUrl: raw.logoUrl ?? null,
    enabled: raw.enabled !== false,
    sortOrder: Number.isInteger(raw.sortOrder) ? raw.sortOrder : 0,
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function fetchConfigVersion(): Promise<number> {
  const body = await request<{ version: number }>('/api/config/version', { timeoutMs: 8_000 });
  return body.version;
}

/**
 * Pulls the full configuration.
 *
 * Assets that fail re-validation are dropped rather than shown: an asset the
 * client cannot verify is one it must not offer to send.
 */
export async function fetchConfig(): Promise<{ config: AppConfig; rejected: string[] }> {
  const body = await request<{
    version: number;
    testnetOnly: boolean;
    signingMode?: SigningMode;
    senderAddress?: string | null;
    networks: unknown[];
    assets: unknown[];
  }>('/api/config');

  const rejected: string[] = [];

  const networks: NetworkConfig[] = [];
  for (const raw of body.networks ?? []) {
    try {
      networks.push(normaliseNetwork(raw));
    } catch (err) {
      rejected.push(err instanceof AppError ? err.message : String(err));
    }
  }

  const assets: AssetConfig[] = [];
  for (const raw of body.assets ?? []) {
    try {
      assets.push(normaliseAsset(raw));
    } catch (err) {
      rejected.push(err instanceof AppError ? err.message : String(err));
    }
  }

  return {
    config: {
      version: body.version,
      testnetOnly: Boolean(body.testnetOnly),
      // An older backend omits this; local signing is the safe assumption,
      // since it never asks the server to hold a key.
      signingMode: body.signingMode === 'custodial' ? 'custodial' : 'local',
      senderAddress: body.senderAddress ?? null,
      networks,
      assets,
      fetchedAt: new Date().toISOString(),
    },
    rejected,
  };
}

export interface RecordTransactionInput {
  clientRef: string;
  txHash: string | null;
  chainId: number;
  status: TxState;
  assetId: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
  contractAddress: string | null;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  amountDisplay: string;
  nonce: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function recordTransaction(input: RecordTransactionInput) {
  return request<{ transaction: { id: string } }>('/api/transactions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface UpdateTransactionInput {
  status: TxState;
  txHash?: string | null;
  blockNumber?: number | null;
  gasUsed?: string | null;
  effectiveGasPrice?: string | null;
  feeRaw?: string | null;
  confirmations?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function updateTransaction(id: string, input: UpdateTransactionInput) {
  return request<{ transaction: unknown }>(`/api/transactions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------
// Custodial sending
//
// Used only when the backend reports signingMode "custodial". The same
// two-phase shape as local signing: prepare returns a quote held server-side,
// confirm broadcasts it by reference so the transaction signed is the one
// that was displayed.
// ---------------------------------------------------------------------------

export interface ServerWalletInfo {
  custodial: boolean;
  address: string | null;
  asset: { raw: string; formatted: string; symbol: string; decimals: number } | null;
  native: { raw: string; formatted: string; symbol: string; decimals: number } | null;
  limit: { maxPerTx: string; maxPerDay: string } | null;
}

export async function fetchServerWallet(assetId?: string): Promise<ServerWalletInfo> {
  const query = assetId ? `?assetId=${encodeURIComponent(assetId)}` : '';
  return request<ServerWalletInfo>(`/api/wallet${query}`);
}

export async function prepareServerSend(input: {
  assetId: string;
  recipient: string;
  amount: string;
}): Promise<TransferQuote> {
  const quote = await request<Omit<TransferQuote, 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasPrice'>>(
    '/api/send/prepare',
    { method: 'POST', body: JSON.stringify(input), timeoutMs: 45_000 },
  );

  // Fee parameters stay on the server with the stored quote; the client never
  // needs them, and shipping them would only invite tampering.
  return { ...quote, maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: null };
}

export async function confirmServerSend(clientRef: string) {
  return request<{
    id: string;
    clientRef: string;
    txHash: string | null;
    status: TxState;
    explorerUrl: string | null;
  }>('/api/send/confirm', {
    method: 'POST',
    body: JSON.stringify({ clientRef }),
    timeoutMs: 90_000,
  });
}

/** The server-side ledger for this installation, used as history in custodial mode. */
export async function fetchServerTransactions() {
  return request<{ transactions: Record<string, unknown>[] }>('/api/transactions?limit=200');
}

/** Connectivity check used by the Settings screen. */
export async function testConnection(): Promise<{ version: number }> {
  return { version: await fetchConfigVersion() };
}
