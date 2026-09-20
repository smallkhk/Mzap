/**
 * Portal API client.
 *
 * There is no separate login system here — the API key the customer was
 * handed *is* the credential, sent as `X-API-Key` on every request, exactly
 * as the desktop app sends it. "Signing in" is just validating that key
 * against `GET /api/portal/me` once and remembering it for the tab.
 *
 * The key lives in `sessionStorage`, never `localStorage`: it survives a
 * page reload but is gone the moment the tab closes, and it never leaves
 * this browser except as the header on requests to this same backend.
 */

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
const KEY_STORAGE = 'fs.portal.apiKey';

let apiKey: string | null = sessionStorage.getItem(KEY_STORAGE);

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fieldErrors?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

export const isSignedIn = () => Boolean(apiKey);

export function signOut(): void {
  apiKey = null;
  sessionStorage.removeItem(KEY_STORAGE);
}

async function raw<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!apiKey) throw new ApiError('NOT_SIGNED_IN', 'Enter your API key to continue.');

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(
      'NETWORK',
      BASE
        ? `Could not reach the backend at ${BASE}. Check that it is running.`
        : 'Could not reach the backend. It may be restarting — refresh in a moment.',
    );
  }

  if (response.status === 401) {
    // The key was rejected outright — revoked, or never valid. Drop it so
    // the login screen shows rather than repeating the same failed request.
    signOut();
    throw new ApiError('UNAUTHORIZED', 'This API key is not recognised or has been revoked.');
  }

  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(
      error?.code ?? 'ERROR',
      error?.message ?? `The request failed with HTTP ${response.status}.`,
      error?.details as { field: string; message: string }[] | undefined,
    );
  }

  return body as T;
}

/** Validates a pasted key by using it, then keeps it if that succeeds. */
export async function signIn(key: string): Promise<Account> {
  const trimmed = key.trim();
  if (!trimmed) throw new ApiError('KEY_REQUIRED', 'Paste your API key.');

  apiKey = trimmed;
  try {
    const account = await raw<Account>('/api/portal/me');
    sessionStorage.setItem(KEY_STORAGE, trimmed);
    return account;
  } catch (err) {
    apiKey = null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Domain types — a deliberate subset of the admin dashboard's shapes. This
// app has no route that can return another client, a plaintext key, or a
// network write, so there is nothing here to model for those.
// ---------------------------------------------------------------------------

export interface Account {
  name: string;
  keyPrefix: string;
  isActive: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  custodial: boolean;
  address: string | null;
  buyEnabled: boolean;
  buyWalletAddress: string | null;
}

export interface BuyQuote {
  quoteRef: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenDecimals: number;
  spendSymbol: string;
  amountInDisplay: string;
  marketAmountOutDisplay: string;
  buyerAmountOutDisplay: string;
  markupBps: number;
  executesVia: 'lifi';
  comparisons: { source: string; amountOutDisplay: string }[];
  expiresInSeconds: number;
}

export interface BuyResult {
  id: string;
  txHash: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  creditedDisplay: string;
  explorerUrl: string;
}

export interface Network {
  key: string;
  name: string;
  chainId: number;
  nativeSymbol: string;
  isTestnet: boolean;
}

export interface Asset {
  id: string;
  name: string;
  symbol: string;
  network: { key: string; name: string };
  chainId: number;
  contractAddress: string | null;
  decimals: number;
  isNative: boolean;
  enabled: boolean;
}

export interface SpendingLimit {
  assetId: string;
  maxPerTx: string;
  maxPerDay: string;
  enabled: boolean;
}

export const api = {
  me: () => raw<Account>('/api/portal/me'),

  networks: {
    list: () => raw<{ networks: Network[] }>('/api/portal/networks'),
  },

  assets: {
    list: () => raw<{ assets: Asset[] }>('/api/portal/assets'),
    create: (data: {
      assetId: string;
      name: string;
      symbol: string;
      networkKey: string;
      contractAddress: string;
      decimals: number;
      explorerUrl?: string;
      logoUrl?: string;
    }) =>
      raw<{ asset: Asset; configVersion: number }>('/api/portal/assets', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },

  limits: {
    list: () => raw<{ limits: SpendingLimit[] }>('/api/portal/limits'),
    set: (limit: SpendingLimit) =>
      raw<{ limit: SpendingLimit }>('/api/portal/limits', {
        method: 'PUT',
        body: JSON.stringify(limit),
      }),
    revoke: (assetId: string) =>
      raw<{ revoked: boolean }>(`/api/portal/limits/${encodeURIComponent(assetId)}`, {
        method: 'DELETE',
      }),
  },

  buy: {
    /** Idempotent: returns the existing address, or generates and assigns one. */
    wallet: () => raw<{ address: string }>('/api/portal/buy/wallet'),
    quote: (data: { spendAssetId: string; tokenAddress: string; amountIn: string }) =>
      raw<BuyQuote>('/api/portal/buy/quote', { method: 'POST', body: JSON.stringify(data) }),
    execute: (quoteRef: string) =>
      raw<BuyResult>('/api/portal/buy/execute', { method: 'POST', body: JSON.stringify({ quoteRef }) }),
  },
};
