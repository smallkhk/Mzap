/**
 * Types shared between the Electron main process and the React renderer.
 *
 * The renderer never imports `ethers` and never sees key material — it only
 * ever handles the plain data described here, over the IPC surface declared
 * in `electron/preload.ts`.
 */

export type TxState =
  | 'PREPARING'
  | 'AWAITING_CONFIRMATION'
  | 'SIGNING'
  | 'BROADCASTING'
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REJECTED';

export interface NetworkConfig {
  key: string;
  name: string;
  chainId: number;
  rpcUrls: string[];
  explorerUrl: string;
  nativeSymbol: string;
  nativeName: string;
  nativeDecimals: number;
  isTestnet: boolean;
}

/** An asset as defined by the backend. The client adds no assets of its own. */
export interface AssetConfig {
  id: string;
  name: string;
  symbol: string;
  network: NetworkConfig;
  chainId: number;
  contractAddress: string | null;
  decimals: number;
  isNative: boolean;
  explorerUrl: string;
  logoUrl: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface AppConfig {
  version: number;
  testnetOnly: boolean;
  networks: NetworkConfig[];
  assets: AssetConfig[];
  fetchedAt: string;
}

export interface WalletStatus {
  /** Whether a wallet has been imported into the encrypted vault at all. */
  hasWallet: boolean;
  /** Whether the vault is currently unlocked in memory. */
  unlocked: boolean;
  address: string | null;
  /** Whether OS-level encryption (DPAPI on Windows) backs the vault file. */
  osEncryptionAvailable: boolean;
  /** Seconds of inactivity before the vault re-locks itself. */
  autoLockSeconds: number;
}

export interface BalanceInfo {
  /** Base-unit integer, as a decimal string. */
  raw: string;
  /** Formatted for display, full precision, no rounding. */
  formatted: string;
  symbol: string;
  decimals: number;
}

export interface ChainStatus {
  connected: boolean;
  chainId: number | null;
  /** The chain id the RPC endpoint actually reported, when it could be read. */
  reportedChainId: number | null;
  blockNumber: number | null;
  rpcUrl: string | null;
  error: string | null;
}

/** The result of preparing a transfer — everything the confirmation screen shows. */
export interface TransferQuote {
  /**
   * Identifies this specific prepared transfer. Confirming sends *this*
   * reference back, so the transaction that gets signed is exactly the one
   * the user was shown — the renderer cannot alter the amount or recipient
   * between the confirmation screen and the signature.
   */
  clientRef: string;
  assetId: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
  contractAddress: string | null;
  network: { key: string; name: string; chainId: number; isTestnet: boolean };
  from: string;
  to: string;
  amountRaw: string;
  amountDisplay: string;

  gasLimit: string;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  gasPrice: string | null;
  /** gasLimit * effective price, in native base units. */
  estimatedFeeRaw: string;
  estimatedFeeDisplay: string;
  nativeSymbol: string;

  assetBalanceRaw: string;
  nativeBalanceRaw: string;

  /** Non-fatal things the user should read before confirming. */
  warnings: string[];
}

export interface TransactionRecord {
  id: string;
  clientRef: string;
  txHash: string | null;
  chainId: number;
  networkName: string;
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
  blockNumber: number | null;
  gasUsed: string | null;
  effectiveGasPrice: string | null;
  feeRaw: string | null;
  feeDisplay: string | null;
  nativeSymbol: string;
  nativeDecimals: number;
  nonce: number | null;
  confirmations: number;
  errorCode: string | null;
  errorMessage: string | null;
  submittedAt: string;
  broadcastAt: string | null;
  confirmedAt: string | null;
  explorerUrl: string | null;
}

export interface AppSettings {
  apiBaseUrl: string;
  /** True when an API key is stored; the key itself is never sent to the UI. */
  hasApiKey: boolean;
  /** Operator-facing safety switch, independent of the backend's own. */
  allowMainnet: boolean;
  theme: 'dark' | 'light' | 'system';
  autoLockSeconds: number;
  configPollSeconds: number;
  minConfirmations: number;
}

/** Every IPC call resolves to this envelope — never a thrown string. */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; detail?: string } };

export interface TransferProgressEvent {
  clientRef: string;
  state: TxState;
  txHash?: string | null;
  blockNumber?: number | null;
  confirmations?: number;
  message?: string;
  errorCode?: string;
}
