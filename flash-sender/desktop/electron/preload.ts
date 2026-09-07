import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppConfig,
  AppSettings,
  IpcResult,
  TransactionRecord,
  TransferProgressEvent,
  TransferQuote,
  WalletStatus,
} from '../shared/types';

/**
 * The bridge between the renderer and the main process.
 *
 * This is an explicit allow-list. `contextIsolation` is on and
 * `nodeIntegration` is off, so the renderer's only capability is what is
 * enumerated here — it cannot reach `fs`, `child_process`, `ipcRenderer`
 * itself, or any channel not named below.
 */

const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args);

const api = {
  wallet: {
    status: () => invoke<WalletStatus>('wallet:status'),
    create: (passphrase: string) =>
      invoke<{ address: string; mnemonic: string }>('wallet:create', passphrase),
    importPrivateKey: (privateKey: string, passphrase: string) =>
      invoke<{ address: string }>('wallet:importPrivateKey', privateKey, passphrase),
    importMnemonic: (phrase: string, passphrase: string, derivationPath?: string) =>
      invoke<{ address: string }>('wallet:importMnemonic', phrase, passphrase, derivationPath),
    unlock: (passphrase: string) => invoke<{ address: string }>('wallet:unlock', passphrase),
    lock: () => invoke<{ locked: boolean }>('wallet:lock'),
    remove: (passphrase: string) => invoke<void>('wallet:remove', passphrase),
  },

  config: {
    get: () => invoke<{ config: AppConfig | null; rejected: string[] }>('config:get'),
    refresh: () => invoke<{ config: AppConfig; rejected: string[] }>('config:refresh'),
    testConnection: () => invoke<{ version: number }>('config:testConnection'),
  },

  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    update: (patch: Partial<AppSettings> & { apiKey?: string | null }) =>
      invoke<AppSettings>('settings:update', patch),
  },

  chain: {
    status: (assetId: string) =>
      invoke<{
        connected: boolean;
        chainId: number | null;
        reportedChainId: number | null;
        blockNumber: number | null;
        rpcUrl: string | null;
        error: string | null;
      }>('chain:status', assetId),
    balance: (assetId: string) =>
      invoke<{
        address: string | null;
        asset: { raw: string; formatted: string; symbol: string; decimals: number } | null;
        native: { raw: string; formatted: string; symbol: string; decimals: number } | null;
      }>('chain:balance', assetId),
  },

  transfer: {
    prepare: (input: { assetId: string; recipient: string; amount: string }) =>
      invoke<TransferQuote>('transfer:prepare', input),
    confirm: (clientRef: string) => invoke<TransactionRecord>('transfer:confirm', clientRef),
    reject: (clientRef: string) => invoke<void>('transfer:reject', clientRef),
    max: (assetId: string) => invoke<{ amount: string; note: string | null }>('transfer:max', assetId),
  },

  history: {
    list: () => invoke<TransactionRecord[]>('history:list'),
    get: (clientRef: string) => invoke<TransactionRecord | null>('history:get', clientRef),
    clear: () => invoke<void>('history:clear'),
  },

  shell: {
    openExternal: (url: string) => invoke<{ opened: boolean }>('shell:openExternal', url),
  },

  /**
   * Event subscriptions. Each returns an unsubscribe function so React
   * effects can clean up without leaking listeners.
   */
  on: {
    transferProgress: (fn: (event: TransferProgressEvent) => void) => {
      const listener = (_e: unknown, payload: TransferProgressEvent) => fn(payload);
      ipcRenderer.on('transfer:progress', listener);
      return () => {
        ipcRenderer.removeListener('transfer:progress', listener);
      };
    },
    walletLocked: (fn: (event: { reason: string }) => void) => {
      const listener = (_e: unknown, payload: { reason: string }) => fn(payload);
      ipcRenderer.on('wallet:locked', listener);
      return () => {
        ipcRenderer.removeListener('wallet:locked', listener);
      };
    },
    configChanged: (fn: (event: { config: AppConfig; rejected: string[] }) => void) => {
      const listener = (_e: unknown, payload: { config: AppConfig; rejected: string[] }) =>
        fn(payload);
      ipcRenderer.on('config:changed', listener);
      return () => {
        ipcRenderer.removeListener('config:changed', listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('flashSender', api);

export type FlashSenderApi = typeof api;
