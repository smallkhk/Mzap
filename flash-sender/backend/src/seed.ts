/**
 * Seeds a safe development environment.
 *
 * Only *testnets* are seeded. Mainnet networks and mainnet token contracts are
 * deliberately not shipped in code — you add those through the admin dashboard
 * on a production deployment, which is the whole point of backend-driven
 * configuration. Nothing here can move real funds.
 */
import { prisma } from './lib/db';
import { logger } from './lib/logger';
import { bumpConfigVersion } from './services/configVersion';
import { normaliseAddress } from './lib/chain';

const NETWORKS = [
  {
    key: 'bsc-testnet',
    name: 'BNB Smart Chain Testnet',
    chainId: 97,
    rpcUrls: [
      'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
      'https://bsc-testnet-rpc.publicnode.com',
    ],
    explorerUrl: 'https://testnet.bscscan.com',
    nativeSymbol: 'tBNB',
    nativeName: 'Test BNB',
    nativeDecimals: 18,
    isTestnet: true,
    sortOrder: 10,
  },
  {
    key: 'sepolia',
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
    explorerUrl: 'https://sepolia.etherscan.io',
    nativeSymbol: 'SepoliaETH',
    nativeName: 'Sepolia Ether',
    nativeDecimals: 18,
    isTestnet: true,
    sortOrder: 20,
  },
  {
    key: 'polygon-amoy',
    name: 'Polygon Amoy',
    chainId: 80002,
    rpcUrls: ['https://rpc-amoy.polygon.technology', 'https://polygon-amoy-bor-rpc.publicnode.com'],
    explorerUrl: 'https://amoy.polygonscan.com',
    nativeSymbol: 'POL',
    nativeName: 'Polygon Ecosystem Token (testnet)',
    nativeDecimals: 18,
    isTestnet: true,
    sortOrder: 30,
  },
];

/**
 * Native coins only. Test ERC-20s vary by faucet and go stale quickly, so you
 * add the ones you actually hold through the admin dashboard — see
 * docs/ADDING-A-TOKEN.md.
 */
const NATIVE_ASSETS = [
  { networkKey: 'bsc-testnet', assetId: 'tbnb', name: 'Test BNB', symbol: 'tBNB' },
  { networkKey: 'sepolia', assetId: 'sepolia-eth', name: 'Sepolia Ether', symbol: 'ETH' },
  { networkKey: 'polygon-amoy', assetId: 'amoy-pol', name: 'Amoy POL', symbol: 'POL' },
];

async function main() {
  for (const network of NETWORKS) {
    const saved = await prisma.network.upsert({
      where: { key: network.key },
      update: network,
      create: network,
    });
    logger.info({ key: saved.key, chainId: saved.chainId }, 'Seeded network');
  }

  for (const asset of NATIVE_ASSETS) {
    const network = await prisma.network.findUniqueOrThrow({ where: { key: asset.networkKey } });

    await prisma.asset.upsert({
      where: { assetId: asset.assetId },
      update: {
        name: asset.name,
        symbol: asset.symbol,
        decimals: network.nativeDecimals,
        isNative: true,
        contractAddress: null,
        networkId: network.id,
      },
      create: {
        assetId: asset.assetId,
        name: asset.name,
        symbol: asset.symbol,
        decimals: network.nativeDecimals,
        isNative: true,
        contractAddress: null,
        networkId: network.id,
        enabled: true,
        sortOrder: 0,
      },
    });
    logger.info({ assetId: asset.assetId }, 'Seeded native asset');
  }

  // Guard against a typo in this file ever producing an unusable contract.
  const tokens = await prisma.asset.findMany({ where: { isNative: false } });
  for (const token of tokens) {
    if (token.contractAddress) normaliseAddress(token.contractAddress, `Asset ${token.assetId}`);
  }

  const version = await bumpConfigVersion();
  logger.info({ version }, 'Seed complete — configuration version bumped');
}

main()
  .catch((err) => {
    logger.error({ err }, 'Seed failed');
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
