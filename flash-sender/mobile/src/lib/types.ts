export interface NetworkConfig {
  key: string;
  name: string;
  chainId: number;
  explorerUrl: string;
  nativeSymbol: string;
  nativeDecimals: number;
  isTestnet: boolean;
}

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
  enabled: boolean;
  sortOrder: number;
}

export interface AppConfig {
  version: number;
  testnetOnly: boolean;
  signingMode: 'local' | 'custodial';
  senderAddress: string | null;
  networks: NetworkConfig[];
  assets: AssetConfig[];
}

export interface ServerWalletInfo {
  custodial: boolean;
  address: string | null;
  asset: { raw: string; formatted: string; symbol: string; decimals: number } | null;
  native: { raw: string; formatted: string; symbol: string; decimals: number } | null;
  limit: { maxPerTx: string; maxPerDay: string } | null;
}

/** Everything the confirmation screen shows, from POST /api/send/prepare. */
export interface TransferQuote {
  clientRef: string;
  assetId: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
  network: { key: string; name: string; chainId: number; isTestnet: boolean };
  from: string;
  to: string;
  amountRaw: string;
  amountDisplay: string;
  estimatedFeeDisplay: string;
  nativeSymbol: string;
  warnings: string[];
}

export type TxState =
  | 'PREPARING'
  | 'AWAITING_CONFIRMATION'
  | 'SIGNING'
  | 'BROADCASTING'
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REJECTED';

/** Matches the backend's serializeTransaction output exactly (see backend/src/services/serialize.ts). */
export interface TransactionRecord {
  id: string;
  clientRef: string;
  txHash: string | null;
  chainId: number;
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
  nonce: number | null;
  confirmations: number;
  errorCode: string | null;
  errorMessage: string | null;
  submittedAt: string;
  broadcastAt: string | null;
  confirmedAt: string | null;
  explorerUrl: string | null;
}
