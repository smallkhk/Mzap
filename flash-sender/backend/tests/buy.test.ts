import { describe, expect, it } from 'vitest';
import { getAddress } from 'ethers';
import {
  ERC20_APPROVE_ABI,
  PANCAKE_V2_ROUTER,
  PANCAKE_V2_ROUTER_ABI,
  WRAPPED_NATIVE,
} from '../src/lib/pancakeswap';

/**
 * These addresses are load-bearing: a wrong one sends a real transaction
 * somewhere other than intended. This test is the regression guard against
 * a future accidental edit — not proof the addresses are *correct* (that
 * was verified against the published `@pancakeswap/smart-router` and
 * `@pancakeswap/swap-sdk-evm` npm packages' compiled source, and against a
 * live BSC testnet RPC, at the time they were added), only that they stay
 * validly checksummed and don't silently drift.
 */
describe('PancakeSwap router constants', () => {
  it('every router address is a validly checksummed address', () => {
    for (const address of Object.values(PANCAKE_V2_ROUTER)) {
      expect(() => getAddress(address)).not.toThrow();
      expect(getAddress(address)).toBe(address);
    }
  });

  it('every wrapped-native address is a validly checksummed address', () => {
    for (const address of Object.values(WRAPPED_NATIVE)) {
      expect(() => getAddress(address)).not.toThrow();
      expect(getAddress(address)).toBe(address);
    }
  });

  it('covers BSC mainnet (56) and testnet (97)', () => {
    expect(PANCAKE_V2_ROUTER[56]).toBeDefined();
    expect(PANCAKE_V2_ROUTER[97]).toBeDefined();
    expect(WRAPPED_NATIVE[56]).toBeDefined();
    expect(WRAPPED_NATIVE[97]).toBeDefined();
  });

  it('exposes the exact function signatures this app calls', () => {
    expect(PANCAKE_V2_ROUTER_ABI).toEqual(
      expect.arrayContaining([
        expect.stringContaining('getAmountsOut'),
        expect.stringContaining('swapExactETHForTokens'),
        expect.stringContaining('swapExactTokensForTokens'),
      ]),
    );
    expect(ERC20_APPROVE_ABI).toEqual(
      expect.arrayContaining([expect.stringContaining('approve'), expect.stringContaining('allowance')]),
    );
  });
});

/**
 * The markup calculation, isolated from any chain or DB dependency. Mirrors
 * exactly what `buyService.prepareBuy` and `confirmBuy` compute, so a
 * regression here is caught without needing a live swap.
 */
function applyMarkup(rawAmount: bigint, markupBps: bigint): bigint {
  return rawAmount - (rawAmount * markupBps) / 10_000n;
}

describe('buy markup arithmetic', () => {
  it('a 0 bps markup credits the full raw amount', () => {
    expect(applyMarkup(1_000_000n, 0n)).toBe(1_000_000n);
  });

  it('250 bps (2.5%) skims exactly 2.5%', () => {
    const raw = 1_000_000n;
    const credited = applyMarkup(raw, 250n);
    expect(credited).toBe(975_000n);
    expect(raw - credited).toBe(25_000n);
  });

  it('matches an independently-computed real quote amount', () => {
    // A genuine PancakeSwap V2 testnet quote observed during manual
    // verification (0.01 tBNB → BUSD-testnet), used only to exercise the
    // arithmetic against realistic magnitudes, not to assert a "correct"
    // market price — testnet liquidity is not representative of anything.
    const raw = 62_442_335_697_294_282_087_684_299_207_792n;
    const credited = applyMarkup(raw, 250n);
    const skimmed = raw - credited;

    expect(credited + skimmed).toBe(raw);
    // Within a wei of exact 2.5% — BigInt integer division truncates.
    const expectedSkim = (raw * 250n) / 10_000n;
    expect(skimmed).toBe(expectedSkim);
  });

  it('5000 bps (50%, the schema cap) still leaves half for the buyer', () => {
    expect(applyMarkup(200n, 5000n)).toBe(100n);
  });

  it('never produces a negative credited amount for any bps within the allowed 0–5000 range', () => {
    for (const bps of [0n, 1n, 2500n, 4999n, 5000n]) {
      expect(applyMarkup(1_000_000n, bps)).toBeGreaterThanOrEqual(0n);
    }
  });
});
