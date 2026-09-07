/**
 * Admin API client.
 *
 * The access token lives in memory only — never `localStorage`, so an XSS in
 * this dashboard cannot lift a long-lived credential out of storage. The
 * refresh token is kept in `sessionStorage` so a page reload does not force a
 * re-login, and is rotated on every use by the backend.
 */

/**
 * API base URL.
 *
 * Empty means "same origin", which is how the dashboard runs when the backend
 * serves it (the cPanel/single-app deployment): requests go to /api/... on
 * whatever host the page was loaded from, so there is nothing to configure and
 * no CORS involved. Set VITE_API_BASE_URL only when the dashboard is hosted
 * separately from the API.
 */
const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

const REFRESH_KEY = 'fs.admin.refresh';

let accessToken: string | null = null;

export interface AdminUser {
  id: string;
  email: string;
  role: 'ADMIN' | 'VIEWER';
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fieldErrors?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

export const getRefreshToken = () => sessionStorage.getItem(REFRESH_KEY);
const setRefreshToken = (token: string | null) => {
  if (token) sessionStorage.setItem(REFRESH_KEY, token);
  else sessionStorage.removeItem(REFRESH_KEY);
};

export const isAuthenticated = () => Boolean(accessToken);

async function raw<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(
      'NETWORK',
      BASE
        ? `Could not reach the backend at ${BASE}. Check that it is running and that this ` +
          'origin is listed in its ADMIN_ORIGINS setting.'
        : 'Could not reach the backend. It may be restarting — refresh in a moment.',
    );
  }

  // Transparently refresh once on a 401, then replay the request.
  if (response.status === 401 && retry && getRefreshToken()) {
    const refreshed = await refresh();
    if (refreshed) return raw<T>(path, init, false);
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

export async function login(email: string, password: string): Promise<AdminUser> {
  const body = await raw<{ accessToken: string; refreshToken: string; user: AdminUser }>(
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    false,
  );

  accessToken = body.accessToken;
  setRefreshToken(body.refreshToken);
  return body.user;
}

export async function refresh(): Promise<AdminUser | null> {
  const token = getRefreshToken();
  if (!token) return null;

  try {
    const body = await raw<{ accessToken: string; refreshToken: string; user: AdminUser }>(
      '/api/auth/refresh',
      { method: 'POST', body: JSON.stringify({ refreshToken: token }) },
      false,
    );
    accessToken = body.accessToken;
    setRefreshToken(body.refreshToken);
    return body.user;
  } catch {
    accessToken = null;
    setRefreshToken(null);
    return null;
  }
}

export async function logout(): Promise<void> {
  const token = getRefreshToken();
  if (token) {
    await raw('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: token }),
    }).catch(() => undefined);
  }
  accessToken = null;
  setRefreshToken(null);
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Network {
  key: string;
  name: string;
  chainId: number;
  rpcUrls: string[];
  explorerUrl: string;
  nativeSymbol: string;
  nativeName: string;
  nativeDecimals: number;
  isTestnet: boolean;
  enabled: boolean;
  sortOrder: number;
  assetCount?: number;
}

export interface Asset {
  id: string;
  name: string;
  symbol: string;
  network: Network;
  chainId: number;
  contractAddress: string | null;
  decimals: number;
  isNative: boolean;
  explorerUrl: string;
  logoUrl: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface AuditEntry {
  id: string;
  actorType: string;
  actorLabel: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  ip: string | null;
  createdAt: string;
}

export const api = {
  networks: {
    list: () => raw<{ networks: Network[] }>('/api/admin/networks'),
    create: (data: Partial<Network>) =>
      raw<{ network: Network; configVersion: number }>('/api/admin/networks', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (key: string, data: Partial<Network>) =>
      raw<{ network: Network; configVersion: number }>(`/api/admin/networks/${key}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    remove: (key: string) =>
      raw<{ deleted: boolean }>(`/api/admin/networks/${key}`, { method: 'DELETE' }),
  },

  assets: {
    list: () => raw<{ version: number; assets: Asset[] }>('/api/admin/assets'),
    create: (data: Record<string, unknown>) =>
      raw<{ asset: Asset; configVersion: number }>('/api/admin/assets', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (assetId: string, data: Record<string, unknown>) =>
      raw<{ asset: Asset; configVersion: number }>(`/api/admin/assets/${assetId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    toggle: (assetId: string) =>
      raw<{ asset: Asset; configVersion: number }>(`/api/admin/assets/${assetId}/toggle`, {
        method: 'POST',
      }),
    remove: (assetId: string) =>
      raw<{ deleted: boolean }>(`/api/admin/assets/${assetId}`, { method: 'DELETE' }),
  },

  clients: {
    list: () =>
      raw<{
        clients: {
          id: string;
          name: string;
          keyPrefix: string;
          isActive: boolean;
          lastSeenAt: string | null;
          createdAt: string;
        }[];
      }>('/api/admin/clients'),
    create: (name: string) =>
      raw<{ client: { id: string; name: string }; apiKey: string; notice: string }>(
        '/api/admin/clients',
        { method: 'POST', body: JSON.stringify({ name }) },
      ),
    revoke: (id: string) =>
      raw<{ revoked: boolean }>(`/api/admin/clients/${id}/revoke`, { method: 'POST' }),
  },

  audit: {
    list: () => raw<{ logs: AuditEntry[] }>('/api/admin/audit?limit=200'),
  },

  transactions: {
    list: () => raw<{ transactions: Record<string, unknown>[] }>('/api/admin/transactions?limit=200'),
  },
};
