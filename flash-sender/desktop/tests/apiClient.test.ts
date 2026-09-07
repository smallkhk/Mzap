import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The main-process backend client.
 *
 * The case that matters here is the difference between "your key was
 * rejected" and "you are authenticated but not allowed to do this". Those
 * arrive as 401 and 403 respectively, and conflating them hid the real reason
 * a custodial send was refused behind a message telling the user to ask for a
 * new API key.
 */

vi.mock('../electron/services/settings', () => ({
  getSettings: async () => ({ apiBaseUrl: 'https://backend.example' }),
  getApiKey: async () => 'test-key',
}));

const { prepareServerSend } = await import('../electron/services/apiClient');

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const send = () =>
  prepareServerSend({ assetId: 'bnb', recipient: '0x' + '1'.repeat(40), amount: '1' });

describe('backend error mapping', () => {
  it('reports a rejected key on 401', async () => {
    respondWith(401, { error: { code: 'UNAUTHORIZED', message: 'This API key is not recognised.' } });

    await expect(send()).rejects.toMatchObject({ code: 'API_KEY_REJECTED' });
  });

  it('surfaces a 403 spending-limit refusal verbatim instead of blaming the key', async () => {
    const message =
      'This installation is not authorised to send BNB. An administrator must grant it a ' +
      'spending limit for this asset in the dashboard.';
    respondWith(403, { error: { code: 'FORBIDDEN', message } });

    await expect(send()).rejects.toMatchObject({ code: 'FORBIDDEN', message });
  });

  it('surfaces an over-limit refusal with the figures the backend supplied', async () => {
    const message =
      'This transfer of 10 BNB exceeds the per-transaction limit of 0.05 BNB for this installation.';
    respondWith(403, { error: { code: 'FORBIDDEN', message } });

    await expect(send()).rejects.toMatchObject({ message });
  });
});
