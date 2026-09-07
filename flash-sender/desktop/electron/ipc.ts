import { BrowserWindow, ipcMain, shell } from 'electron';
import type { IpcResult } from '../shared/types';
import { ok, toIpcError } from './lib/errors';
import * as wallet from './services/wallet';
import * as vault from './services/vault';
import * as configStore from './services/configStore';
import * as settings from './services/settings';
import * as history from './services/history';
import * as transfer from './services/transferService';
import * as chain from './services/blockchain';
import * as api from './services/apiClient';
import { formatAmount } from './lib/amount';

/**
 * The complete IPC surface.
 *
 * Every handler returns an `IpcResult` envelope rather than throwing across
 * the boundary, so the renderer always receives a structured `{ code,
 * message }` it can display — never an unhandled rejection or a raw stack.
 *
 * Note what is *absent*: there is no channel that returns a private key, a
 * mnemonic (except once, at creation, for the user to record), or the backend
 * API key. Those values have no route out of the main process.
 */

type Handler<A extends unknown[], R> = (...args: A) => Promise<R> | R;

/** Wraps a handler so any throw becomes a structured error result. */
function handle<A extends unknown[], R>(channel: string, fn: Handler<A, R>) {
  ipcMain.handle(channel, async (_event, ...args: A): Promise<IpcResult<R>> => {
    try {
      // Any IPC activity counts as user activity for the auto-lock timer.
      vault.touch();
      return ok(await fn(...args));
    } catch (err) {
      return toIpcError(err);
    }
  });
}

export function registerIpc(getWindow: () => BrowserWindow | null) {
  // Push transaction progress to the renderer as it happens.
  transfer.setProgressEmitter((event) => {
    getWindow()?.webContents.send('transfer:progress', event);
  });

  vault.setAutoLockCallback(() => {
    getWindow()?.webContents.send('wallet:locked', { reason: 'inactivity' });
  });

  configStore.setChangeHandler((config, rejected) => {
    getWindow()?.webContents.send('config:changed', { config, rejected });
  });

  // -------------------------------------------------------------------------
  // Wallet
  // -------------------------------------------------------------------------

  handle('wallet:status', () => wallet.getStatus());

  handle('wallet:create', (passphrase: string) => wallet.createWallet(passphrase));

  handle('wallet:importPrivateKey', (key: string, passphrase: string) =>
    wallet.importPrivateKey(key, passphrase),
  );

  handle('wallet:importMnemonic', (phrase: string, passphrase: string, path?: string) =>
    wallet.importMnemonic(phrase, passphrase, path),
  );

  handle('wallet:unlock', (passphrase: string) => wallet.unlock(passphrase));

  handle('wallet:lock', () => {
    wallet.lock();
    return { locked: true };
  });

  handle('wallet:remove', (passphrase: string) => wallet.removeWallet(passphrase));

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  handle('config:get', () => configStore.getCached());

  handle('config:refresh', () => configStore.refresh());

  handle('config:testConnection', () => api.testConnection());

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  handle('settings:get', () => settings.getSettings());

  handle('settings:update', async (patch: settings.SettingsPatch) => {
    const updated = await settings.updateSettings(patch);

    if (patch.autoLockSeconds !== undefined) vault.setAutoLockSeconds(patch.autoLockSeconds);
    if (patch.configPollSeconds !== undefined) await configStore.startPolling();

    return updated;
  });

  // -------------------------------------------------------------------------
  // Chain reads
  // -------------------------------------------------------------------------

  handle('chain:status', async (assetId: string) => {
    const asset = configStore.requireAsset(assetId);
    return chain.getChainStatus(asset.network);
  });

  /** Balance of the selected asset, plus the native balance used for fees. */
  handle('chain:balance', async (assetId: string) => {
    const asset = configStore.requireAsset(assetId);
    const address = vault.currentAddress();

    if (!address) {
      return { asset: null, native: null, address: null };
    }

    const [assetBalance, nativeRaw] = await Promise.all([
      chain.getBalanceFor(asset, address),
      chain.getNativeBalance(asset.network, address),
    ]);

    return {
      address,
      asset: {
        raw: assetBalance.raw.toString(),
        formatted: assetBalance.formatted,
        symbol: asset.symbol,
        decimals: asset.decimals,
      },
      native: {
        raw: nativeRaw.toString(),
        formatted: formatAmount(nativeRaw, asset.network.nativeDecimals),
        symbol: asset.network.nativeSymbol,
        decimals: asset.network.nativeDecimals,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Transfers
  // -------------------------------------------------------------------------

  /** Step 1: validate + estimate. Returns what the confirmation screen shows. */
  handle('transfer:prepare', async (input: { assetId: string; recipient: string; amount: string }) => {
    const asset = configStore.requireAsset(input.assetId);
    return transfer.prepareTransfer({
      asset,
      recipient: input.recipient,
      amount: input.amount,
    });
  });

  /** Step 2: the user confirmed. Sign and broadcast. */
  handle('transfer:confirm', (clientRef: string) => transfer.executeTransfer(clientRef));

  /** The user cancelled at the confirmation screen. Nothing was signed. */
  handle('transfer:reject', (clientRef: string) => transfer.rejectTransfer(clientRef));

  handle('transfer:max', async (assetId: string) => {
    const asset = configStore.requireAsset(assetId);
    return transfer.computeMax(asset);
  });

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  handle('history:list', () => history.listTransactions());

  handle('history:get', (clientRef: string) => history.getTransaction(clientRef));

  handle('history:clear', () => history.clearHistory());

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  /**
   * Opens an explorer link in the user's browser.
   *
   * Only https URLs are permitted, so a malformed configuration value cannot
   * turn into `file://` or a custom-protocol handler launch.
   */
  handle('shell:openExternal', async (url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error(`Refusing to open a non-HTTPS link (${parsed.protocol}).`);
    }
    await shell.openExternal(parsed.toString());
    return { opened: true };
  });
}
