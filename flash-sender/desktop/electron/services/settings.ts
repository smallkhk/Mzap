import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings } from '../../shared/types';
import { AppError } from '../lib/errors';

/**
 * Application settings, including the backend API key.
 *
 * The API base URL and the API key are *deployment* configuration, not build
 * configuration: they are entered by the operator at runtime and stored here,
 * encrypted with the OS keystore (DPAPI on Windows). Nothing environment-
 * specific is baked into the shipped executable.
 *
 * The API key never reaches the renderer process — `AppSettings.hasApiKey` is
 * a boolean, and the key itself is read only by the main-process HTTP client.
 */

const SETTINGS_FILE = 'settings.json';

interface StoredSettings {
  apiBaseUrl: string;
  /** base64 of the DPAPI-encrypted key, or null. */
  apiKeyEncrypted: string | null;
  /** Plaintext fallback, used only where OS encryption is unavailable. */
  apiKeyPlain: string | null;
  allowMainnet: boolean;
  theme: 'dark' | 'light' | 'system';
  autoLockSeconds: number;
  configPollSeconds: number;
  minConfirmations: number;
}

const DEFAULTS: StoredSettings = {
  apiBaseUrl: '',
  apiKeyEncrypted: null,
  apiKeyPlain: null,
  // Mainnet is opt-in. A fresh install cannot move real funds until the
  // operator deliberately turns this on.
  allowMainnet: false,
  theme: 'system',
  autoLockSeconds: 300,
  configPollSeconds: 60,
  minConfirmations: 1,
};

let cache: StoredSettings | null = null;

const settingsPath = () => path.join(app.getPath('userData'), SETTINGS_FILE);

async function load(): Promise<StoredSettings> {
  if (cache) return cache;

  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    cache = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<StoredSettings>) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

async function persist(next: StoredSettings): Promise<void> {
  cache = next;
  const target = settingsPath();
  await fs.writeFile(`${target}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(`${target}.tmp`, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

/**
 * The API base URL must be https, except for loopback during development.
 * This is enforced here so a typo cannot downgrade the connection carrying
 * contract addresses to plaintext.
 */
export function validateApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');

  if (!trimmed) {
    throw new AppError('API_URL_REQUIRED', 'Enter the address of your backend API.');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(
      'API_URL_INVALID',
      `"${value}" is not a valid URL. Include the scheme, for example https://api.example.com.`,
    );
  }

  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);

  if (url.protocol !== 'https:' && !loopback) {
    throw new AppError(
      'API_URL_INSECURE',
      'The backend URL must use https://. A plaintext connection would let a network attacker ' +
        'alter the contract addresses this application sends to.',
    );
  }

  return trimmed;
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await load();
  return {
    apiBaseUrl: stored.apiBaseUrl,
    hasApiKey: Boolean(stored.apiKeyEncrypted || stored.apiKeyPlain),
    allowMainnet: stored.allowMainnet,
    theme: stored.theme,
    autoLockSeconds: stored.autoLockSeconds,
    configPollSeconds: stored.configPollSeconds,
    minConfirmations: stored.minConfirmations,
  };
}

export interface SettingsPatch {
  apiBaseUrl?: string;
  apiKey?: string | null;
  allowMainnet?: boolean;
  theme?: 'dark' | 'light' | 'system';
  autoLockSeconds?: number;
  configPollSeconds?: number;
  minConfirmations?: number;
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  const stored = await load();
  const next: StoredSettings = { ...stored };

  if (patch.apiBaseUrl !== undefined) {
    next.apiBaseUrl = validateApiBaseUrl(patch.apiBaseUrl);
  }

  if (patch.apiKey !== undefined) {
    if (patch.apiKey === null || patch.apiKey === '') {
      next.apiKeyEncrypted = null;
      next.apiKeyPlain = null;
    } else {
      const key = patch.apiKey.trim();
      if (key.length < 16) {
        throw new AppError(
          'API_KEY_INVALID',
          'That does not look like a valid API key. Generate one in the admin dashboard under ' +
            'Clients.',
        );
      }
      if (safeStorage.isEncryptionAvailable()) {
        next.apiKeyEncrypted = safeStorage.encryptString(key).toString('base64');
        next.apiKeyPlain = null;
      } else {
        // Recorded so the UI can warn; still never sent to the renderer.
        next.apiKeyEncrypted = null;
        next.apiKeyPlain = key;
      }
    }
  }

  if (patch.allowMainnet !== undefined) next.allowMainnet = patch.allowMainnet;
  if (patch.theme !== undefined) next.theme = patch.theme;

  if (patch.autoLockSeconds !== undefined) {
    next.autoLockSeconds = Math.max(30, Math.min(3600, Math.floor(patch.autoLockSeconds)));
  }
  if (patch.configPollSeconds !== undefined) {
    next.configPollSeconds = Math.max(15, Math.min(3600, Math.floor(patch.configPollSeconds)));
  }
  if (patch.minConfirmations !== undefined) {
    next.minConfirmations = Math.max(1, Math.min(64, Math.floor(patch.minConfirmations)));
  }

  await persist(next);
  return getSettings();
}

/** Main-process only. Never expose the return value over IPC. */
export async function getApiKey(): Promise<string | null> {
  const stored = await load();

  if (stored.apiKeyEncrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.apiKeyEncrypted, 'base64'));
    } catch {
      throw new AppError(
        'API_KEY_UNREADABLE',
        'The stored API key could not be decrypted. This usually means it was saved by a ' +
          'different Windows user account. Re-enter it in Settings.',
      );
    }
  }

  return stored.apiKeyPlain;
}

export const isOsEncryptionAvailable = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};
