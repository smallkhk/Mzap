import { describe, expect, it } from 'vitest';
import type { AssetConfig, NetworkConfig } from '../shared/types';
import {
  assertChainId,
  buildTransferRequest,
  estimateFee,
  getChainStatus,
  getNativeBalance,
  getTokenBalance,
  verifyTokenContract,
} from '../electron/services/blockchain';
import { parseAmount } from '../electron/lib/amount';

/**
 * Integration tests against a live public testnet.
 *
 * These make real RPC calls and are skipped by default so the unit suite stays
 * hermetic. Run them with:
 *
 *   RUN_CHAIN_TESTS=1 npm test
 *
 * They are read-only: nothing here signs or broadcasts anything, and no
 * funded wallet is required. Their purpose is to prove the blockchain layer
 * talks to a real chain correctly — that chain-id pinning works, that a
 * contract's own `decimals()` is what gets checked, and that a transfer is
 * encoded as a standard ERC-20 call.
 */

const RUN = process.env.RUN_CHAIN_TESTS === '1';

const BSC_TESTNET: NetworkConfig = {
  key: 'bsc-testnet',
  name: 'BNB Smart Chain Testnet',
  chainId: 97,
  rpcUrls: [
    'https://bsc-testnet-rpc.publicnode.com',
    'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  ],
  explorerUrl: 'https://testnet.bscscan.com',
  nativeSymbol: 'tBNB',
  nativeName: 'Test BNB',
  nativeDecimals: 18,
  isTestnet: true,
};

/** The canonical test USDT deployment on BSC testnet. */
const USDT: AssetConfig = {
  id: 'usdt-bsc-testnet',
  name: 'Tether USD (testnet)',
  symbol: 'USDT',
  network: BSC_TESTNET,
  chainId: 97,
  contractAddress: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
  decimals: 18,
  isNative: false,
  explorerUrl: 'https://testnet.bscscan.com',
  logoUrl: null,
  enabled: true,
  sortOrder: 0,
};

const SOME_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

describe.runIf(RUN)('blockchain service (live testnet)', () => {
  it('confirms the RPC endpoint really is the configured chain', async () => {
    await expect(assertChainId(BSC_TESTNET)).resolves.toBe(97);
  }, 30_000);

  it('refuses to proceed when the configured chain id is wrong', async () => {
    // Same endpoint, deliberately mislabelled as Ethereum mainnet.
    const lying: NetworkConfig = { ...BSC_TESTNET, chainId: 1, key: 'lying' };

    await expect(assertChainId(lying)).rejects.toThrow(
      /configured as chain 1, but its RPC endpoint reports chain 97|reported a different chain/i,
    );
  }, 30_000);

  it('reports live connection status with a real block height', async () => {
    const status = await getChainStatus(BSC_TESTNET);

    expect(status.connected).toBe(true);
    expect(status.reportedChainId).toBe(97);
    expect(status.blockNumber).toBeGreaterThan(30_000_000);
    expect(status.error).toBeNull();
  }, 30_000);

  it('verifies the token contract against its own on-chain decimals', async () => {
    const result = await verifyTokenContract(BSC_TESTNET, USDT.contractAddress!, 18, 'USDT');

    expect(result.decimals).toBe(18);
    expect(result.symbol).toBe('USDT');
  }, 30_000);

  it('rejects a decimals mismatch rather than sending the wrong amount', async () => {
    // The contract reports 18; claiming 6 would inflate a transfer 10^12×.
    await expect(
      verifyTokenContract(BSC_TESTNET, USDT.contractAddress!, 6, 'USDT'),
    ).rejects.toThrow(/reports 18 decimals, but this asset is configured with 6/);
  }, 30_000);

  it('rejects an address with no contract deployed at it', async () => {
    await expect(
      verifyTokenContract(BSC_TESTNET, '0x000000000000000000000000000000000000dEaD', 18),
    ).rejects.toThrow(/no contract deployed/i);
  }, 30_000);

  it('reads real balances', async () => {
    const native = await getNativeBalance(BSC_TESTNET, SOME_ADDRESS);
    const token = await getTokenBalance(BSC_TESTNET, USDT.contractAddress!, SOME_ADDRESS);

    expect(typeof native).toBe('bigint');
    expect(typeof token).toBe('bigint');
    expect(native).toBeGreaterThanOrEqual(0n);
  }, 30_000);

  it('encodes a token transfer as a standard ERC-20 call', () => {
    const request = buildTransferRequest(USDT, SOME_ADDRESS, parseAmount('1.5', 18));

    // Sent *to the contract*, carrying calldata, with zero value attached.
    expect(request.to).toBe(USDT.contractAddress);
    expect(request.value).toBe(0n);

    const data = request.data as string;
    expect(data.slice(0, 10)).toBe('0xa9059cbb'); // transfer(address,uint256)
    expect(data.toLowerCase()).toContain(SOME_ADDRESS.slice(2).toLowerCase());

    // 1.5 × 10^18 encoded as the final uint256 word.
    expect(BigInt(`0x${data.slice(-64)}`)).toBe(1_500_000_000_000_000_000n);
  });

  it('encodes a native transfer as a plain value send', () => {
    const native: AssetConfig = {
      ...USDT,
      id: 'tbnb',
      symbol: 'tBNB',
      isNative: true,
      contractAddress: null,
    };

    const request = buildTransferRequest(native, SOME_ADDRESS, parseAmount('0.01', 18));

    // Sent directly to the recipient, with value and no calldata.
    expect(request.to).toBe(SOME_ADDRESS);
    expect(request.value).toBe(10_000_000_000_000_000n);
    expect(request.data).toBeUndefined();
  });

  it('estimates a real fee for a native transfer', async () => {
    const request = buildTransferRequest(
      { ...USDT, isNative: true, contractAddress: null },
      SOME_ADDRESS,
      1n,
    );

    const fee = await estimateFee(BSC_TESTNET, request, SOME_ADDRESS);

    // A bare value transfer costs 21000 gas; we add 20% headroom.
    expect(fee.gasLimit).toBeGreaterThanOrEqual(21_000n);
    expect(fee.totalFee).toBeGreaterThan(0n);
    expect(fee.gasPrice ?? fee.maxFeePerGas).toBeTruthy();
  }, 30_000);
});

describe('transfer encoding (offline)', () => {
  it('always produces the ERC-20 transfer selector for tokens', () => {
    const request = buildTransferRequest(USDT, SOME_ADDRESS, 1n);
    expect((request.data as string).slice(0, 10)).toBe('0xa9059cbb');
  });

  it('refuses to build a token transfer without a valid contract address', () => {
    const broken: AssetConfig = { ...USDT, contractAddress: null };
    expect(() => buildTransferRequest(broken, SOME_ADDRESS, 1n)).toThrow(
      /no valid contract address/,
    );
  });
});
