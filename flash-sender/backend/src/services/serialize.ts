import type { Asset, Network, TransactionRecord } from '@prisma/client';
import { explorerTxUrl } from '../lib/chain';
import { decodeUrlList } from '../lib/columns';

export type AssetWithNetwork = Asset & { network: Network };

/**
 * The wire shape consumed by the desktop application.
 *
 * This is the contract that lets a new token appear in the app with no
 * rebuild: the client renders whatever assets this returns, and derives its
 * send behaviour from `isNative` / `contractAddress` / `decimals`.
 */
export function serializeAsset(asset: AssetWithNetwork) {
  return {
    id: asset.assetId,
    name: asset.name,
    symbol: asset.symbol,
    network: {
      key: asset.network.key,
      name: asset.network.name,
      chainId: asset.network.chainId,
      rpcUrls: decodeUrlList(asset.network.rpcUrlsRaw),
      explorerUrl: asset.network.explorerUrl,
      nativeSymbol: asset.network.nativeSymbol,
      nativeName: asset.network.nativeName,
      nativeDecimals: asset.network.nativeDecimals,
      isTestnet: asset.network.isTestnet,
    },
    chainId: asset.network.chainId,
    contractAddress: asset.contractAddress,
    decimals: asset.decimals,
    isNative: asset.isNative,
    explorerUrl: asset.explorerUrl ?? asset.network.explorerUrl,
    logoUrl: asset.logoUrl,
    enabled: asset.enabled,
    sortOrder: asset.sortOrder,
    updatedAt: asset.updatedAt.toISOString(),
  };
}

export function serializeNetwork(network: Network) {
  return {
    key: network.key,
    name: network.name,
    chainId: network.chainId,
    rpcUrls: decodeUrlList(network.rpcUrlsRaw),
    explorerUrl: network.explorerUrl,
    nativeSymbol: network.nativeSymbol,
    nativeName: network.nativeName,
    nativeDecimals: network.nativeDecimals,
    isTestnet: network.isTestnet,
    enabled: network.enabled,
    sortOrder: network.sortOrder,
    updatedAt: network.updatedAt.toISOString(),
  };
}

/**
 * `explorerUrl` is present only when a real hash exists. A record without a
 * hash is one that never reached the network, and gets no explorer link.
 */
export function serializeTransaction(tx: TransactionRecord, explorerBase?: string | null) {
  return {
    id: tx.id,
    clientRef: tx.clientRef,
    txHash: tx.txHash,
    chainId: tx.chainId,
    status: tx.status,
    assetId: tx.assetId,
    symbol: tx.symbol,
    decimals: tx.decimals,
    isNative: tx.isNative,
    contractAddress: tx.contractAddress,
    fromAddress: tx.fromAddress,
    toAddress: tx.toAddress,
    amountRaw: tx.amountRaw,
    amountDisplay: tx.amountDisplay,
    blockNumber: tx.blockNumber,
    gasUsed: tx.gasUsed,
    effectiveGasPrice: tx.effectiveGasPrice,
    feeRaw: tx.feeRaw,
    nonce: tx.nonce,
    confirmations: tx.confirmations,
    errorCode: tx.errorCode,
    errorMessage: tx.errorMessage,
    submittedAt: tx.submittedAt.toISOString(),
    broadcastAt: tx.broadcastAt?.toISOString() ?? null,
    confirmedAt: tx.confirmedAt?.toISOString() ?? null,
    explorerUrl: tx.txHash && explorerBase ? explorerTxUrl(explorerBase, tx.txHash) : null,
  };
}
