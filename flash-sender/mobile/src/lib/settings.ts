import * as SecureStore from 'expo-secure-store';

/**
 * Persisted app settings. The API key goes through SecureStore (iOS
 * Keychain-backed); the base URL is plain config, no reason to encrypt it.
 */

const KEY_API_BASE_URL = 'apiBaseUrl';
const KEY_API_KEY = 'apiKey';

export interface AppSettings {
  apiBaseUrl: string;
  hasApiKey: boolean;
}

export async function getSettings(): Promise<AppSettings> {
  const [apiBaseUrl, apiKey] = await Promise.all([
    SecureStore.getItemAsync(KEY_API_BASE_URL),
    SecureStore.getItemAsync(KEY_API_KEY),
  ]);
  return { apiBaseUrl: apiBaseUrl ?? '', hasApiKey: Boolean(apiKey) };
}

export async function getApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_API_KEY);
}

export async function updateSettings(patch: { apiBaseUrl?: string; apiKey?: string }): Promise<void> {
  if (patch.apiBaseUrl !== undefined) {
    await SecureStore.setItemAsync(KEY_API_BASE_URL, patch.apiBaseUrl.replace(/\/+$/, ''));
  }
  if (patch.apiKey !== undefined && patch.apiKey !== '') {
    await SecureStore.setItemAsync(KEY_API_KEY, patch.apiKey);
  }
}

export async function clearApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_API_KEY);
}
