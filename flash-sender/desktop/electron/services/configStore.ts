import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, AssetConfig } from '../../shared/types';
import * as api from './apiClient';
import { getSettings } from './settings';
import { AppError } from '../lib/errors';

/**
 * Configuration synchronisation.
 *
 * Holds the last configuration pulled from the backend, caches it on disk so
 * the app can start while offline, and polls `/api/config/version` so a token
 * added in the admin dashboard shows up here without a rebuild or restart.
 */

const CACHE_FILE = 'config-cache.json';

let current: AppConfig | null = null;
let rejected: string[] = [];
let pollTimer: NodeJS.Timeout | null = null;
let onChange: ((config: AppConfig, rejected: string[]) => void) | null = null;

const cachePath = () => path.join(app.getPath('userData'), CACHE_FILE);

export function setChangeHandler(fn: (config: AppConfig, rejected: string[]) => void) {
  onChange = fn;
}

export function getCached(): { config: AppConfig | null; rejected: string[] } {
  return { config: current, rejected };
}

export function getAssets(): AssetConfig[] {
  return current?.assets ?? [];
}

/**
 * Finds an asset by id, and re-checks that it is still enabled and still
 * matches its network. Everything that sends resolves its asset through here
 * rather than trusting an id passed in from the renderer.
 */
export function requireAsset(assetId: string): AssetConfig {
  const asset = current?.assets.find((a) => a.id === assetId);

  if (!asset) {
    throw new AppError(
      'UNKNOWN_ASSET',
      `"${assetId}" is not in the current asset list. Refresh configuration — it may have been ` +
        'removed or disabled by your administrator.',
    );
  }

  if (!asset.enabled) {
    throw new AppError(
      'ASSET_DISABLED',
      `${asset.symbol} has been disabled by your administrator and cannot be sent.`,
    );
  }

  if (!asset.isNative && !asset.contractAddress) {
    throw new AppError(
      'INVALID_CONTRACT',
      `${asset.symbol} is configured as a token but has no contract address.`,
    );
  }

  return asset;
}

async function loadCache(): Promise<AppConfig | null> {
  try {
    const raw = await fs.readFile(cachePath(), 'utf8');
    return JSON.parse(raw) as AppConfig;
  } catch {
    return null;
  }
}

async function saveCache(config: AppConfig): Promise<void> {
  const target = cachePath();
  await fs.writeFile(`${target}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(`${target}.tmp`, target);
}

/** Loads the on-disk cache so the UI has something to show before the first fetch. */
export async function hydrate(): Promise<AppConfig | null> {
  current = await loadCache();
  return current;
}

/**
 * Pulls configuration from the backend and replaces the local copy.
 * Throws if the backend is unreachable — the caller decides whether to fall
 * back to the cache.
 */
export async function refresh(): Promise<{ config: AppConfig; rejected: string[] }> {
  const result = await api.fetchConfig();

  current = result.config;
  rejected = result.rejected;

  await saveCache(result.config);
  onChange?.(result.config, result.rejected);

  return result;
}

/**
 * Starts version polling. Cheap: one small request per interval, and a full
 * refresh only when the version has actually moved.
 */
export async function startPolling(): Promise<void> {
  stopPolling();

  const { configPollSeconds } = await getSettings();

  pollTimer = setInterval(async () => {
    try {
      const version = await api.fetchConfigVersion();
      if (current && version === current.version) return;
      await refresh();
    } catch {
      // Offline or backend down — keep serving the cached configuration and
      // try again on the next tick.
    }
  }, configPollSeconds * 1_000);
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
