import { AppError } from './errors';
import { getApiKey, getSettings } from './settings';
import type {
  AppConfig,
  AssetConfig,
  NetworkConfig,
  ServerWalletInfo,
  TransactionRecord,
  TransferQuote,
} from './types';

/**
 * Client for the backend, custodial mode only — this app never holds a
 * private key, so there is no local-signing branch to carry.
 *
 * Responses are treated as untrusted input: `normaliseAsset` re-validates
 * every field, including contract addresses and chain ids, before it is
 * shown as something the user can send to. A compromised or spoofed backend
 * still cannot hand this app a malformed address.
 */

const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(
  pathname: string,
  init: (RequestInit & { timeoutMs?: number }) = {},
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
      'No backend API key has been configured. Open Settings and paste the key issued by your administrator.',
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
        `The backend at ${settings.apiBaseUrl} did not respond within ${Math.round((init.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)} seconds.`,
      );
    }
    throw new AppError(
      'BACKEND_UNREACHABLE',
      `Could not reach the backend at ${settings.apiBaseUrl}. Check the address in Settings and your internet connection.`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401) {
    throw new AppError(
      'API_KEY_REJECTED',
      "The backend rejected this app's API key. It may have been revoked — ask your administrator to issue a new one.",
    );
  }

  if (response.status === 429) {
    throw new AppError(
      'BACKEND_RATE_LIMITED',
      'The backend is rate-limiting this app. Wait a moment and try again.',
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
  return {
    key: String(raw.key),
    name: String(raw.name),
    chainId: raw.chainId,
    explorerUrl: String(raw.explorerUrl ?? '').replace(/\/+$/, ''),
    nativeSymbol: String(raw.nativeSymbol ?? ''),
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

  if (!isNative && (!contractAddress || !ADDRESS_RE.test(contractAddress))) {
    throw new AppError(
      'CONFIG_INVALID',
      `Token "${raw.symbol}" has a malformed contract address and cannot be used.`,
    );
  }

  if (raw.chainId !== network.chainId) {
    throw new AppError(
      'CONFIG_INVALID',
      `Asset "${raw.symbol}" declares chain ${raw.chainId} but its network is chain ${network.chainId}.`,
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
    enabled: raw.enabled !== false,
    sortOrder: Number.isInteger(raw.sortOrder) ? raw.sortOrder : 0,
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Pulls the full configuration. Assets that fail re-validation are dropped
 * rather than shown: an asset this app cannot verify is one it must not
 * offer to send.
 */
export async function fetchConfig(): Promise<{ config: AppConfig; rejected: string[] }> {
  const body = await request<{
    version: number;
    testnetOnly: boolean;
    signingMode?: 'local' | 'custodial';
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
      signingMode: body.signingMode === 'custodial' ? 'custodial' : 'local',
      senderAddress: body.senderAddress ?? null,
      networks,
      assets,
    },
    rejected,
  };
}

export async function fetchServerWallet(assetId?: string): Promise<ServerWalletInfo> {
  const query = assetId ? `?assetId=${encodeURIComponent(assetId)}` : '';
  return request<ServerWalletInfo>(`/api/wallet${query}`);
}

export async function prepareSend(input: {
  assetId: string;
  recipient: string;
  amount: string;
}): Promise<TransferQuote> {
  return request<TransferQuote>('/api/send/prepare', {
    method: 'POST',
    body: JSON.stringify(input),
    timeoutMs: 45_000,
  });
}

export async function confirmSend(clientRef: string): Promise<{
  id: string;
  clientRef: string;
  txHash: string | null;
  status: TransactionRecord['status'];
  explorerUrl: string | null;
}> {
  return request('/api/send/confirm', {
    method: 'POST',
    body: JSON.stringify({ clientRef }),
    timeoutMs: 90_000,
  });
}

/** The server-side ledger for this installation, used as history in custodial mode. */
export async function fetchTransactions(): Promise<TransactionRecord[]> {
  const body = await request<{ transactions: TransactionRecord[] }>('/api/transactions?limit=200');
  return body.transactions ?? [];
}

/** Connectivity check used by the Settings screen. */
export async function testConnection(): Promise<{ version: number }> {
  const body = await request<{ version: number }>('/api/config/version', { timeoutMs: 8_000 });
  return body;
}
