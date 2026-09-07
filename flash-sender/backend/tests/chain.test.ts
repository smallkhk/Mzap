import { describe, expect, it } from 'vitest';
import { getAddress } from 'ethers';
import {
  assertExplorerUrl,
  assertSecureRpcUrl,
  assertValidBaseUnitAmount,
  assertValidChainId,
  assertValidDecimals,
  assertValidTxHash,
  explorerTxUrl,
  isValidAddress,
  normaliseAddress,
} from '../src/lib/chain';

const LOWERCASE = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';

describe('normaliseAddress', () => {
  it('returns the EIP-55 checksummed form of a lowercase address', () => {
    const checksummed = normaliseAddress(LOWERCASE);

    expect(checksummed).toBe(getAddress(LOWERCASE));
    expect(checksummed).not.toBe(LOWERCASE); // casing actually changed
    expect(checksummed.toLowerCase()).toBe(LOWERCASE);
  });

  it('is idempotent', () => {
    expect(normaliseAddress(normaliseAddress(LOWERCASE))).toBe(normaliseAddress(LOWERCASE));
  });

  it('rejects an address with a bad EIP-55 checksum', () => {
    // Take the valid checksummed form and flip the case of one hex letter.
    const checksummed = normaliseAddress(LOWERCASE);
    const index = [...checksummed].findIndex((c, i) => i > 1 && /[a-fA-F]/.test(c));
    const flipped =
      checksummed.slice(0, index) +
      (checksummed[index] === checksummed[index]!.toUpperCase()
        ? checksummed[index]!.toLowerCase()
        : checksummed[index]!.toUpperCase()) +
      checksummed.slice(index + 1);

    expect(() => normaliseAddress(flipped)).toThrow(/invalid checksum/i);
  });

  it('rejects the zero address', () => {
    expect(() => normaliseAddress('0x0000000000000000000000000000000000000000')).toThrow(
      /zero address/i,
    );
  });

  it('rejects a truncated address with a length-specific message', () => {
    expect(() => normaliseAddress('0x8AC76a51cc950d98')).toThrow(/exactly 42 characters/);
  });

  it('rejects non-hex characters', () => {
    expect(() => normaliseAddress('0xZZc76a51cc950d9822D68b83fE1Ad97B32Cd580d')).toThrow(
      /not valid hexadecimal/,
    );
  });

  it('rejects a missing 0x prefix', () => {
    expect(() => normaliseAddress('8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d')).toThrow(
      /must start with "0x"/,
    );
  });

  it('reports empty input as required', () => {
    expect(() => normaliseAddress('   ')).toThrow(/is required/);
  });

  it('isValidAddress mirrors the thrower without throwing', () => {
    expect(isValidAddress('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d')).toBe(true);
    expect(isValidAddress('nope')).toBe(false);
  });
});

describe('assertValidChainId', () => {
  it.each([1, 56, 97, 137, 11155111])('accepts %i', (id) => {
    expect(assertValidChainId(id)).toBe(id);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects %s', (id) => {
    expect(() => assertValidChainId(id as number)).toThrow();
  });
});

describe('assertValidDecimals', () => {
  it('accepts the common cases', () => {
    expect(assertValidDecimals(18)).toBe(18);
    expect(assertValidDecimals(6)).toBe(6);
    expect(assertValidDecimals(0)).toBe(0);
  });

  it('rejects out-of-range and fractional values', () => {
    expect(() => assertValidDecimals(-1)).toThrow(/between 0 and 36/);
    expect(() => assertValidDecimals(77)).toThrow(/between 0 and 36/);
    expect(() => assertValidDecimals(6.5)).toThrow(/whole number/);
  });
});

describe('assertSecureRpcUrl', () => {
  it('accepts https and wss', () => {
    expect(assertSecureRpcUrl('https://bsc-dataseed.bnbchain.org')).toContain('https://');
    expect(assertSecureRpcUrl('wss://example.org/ws')).toContain('wss://');
  });

  it('accepts plaintext only on loopback', () => {
    expect(assertSecureRpcUrl('http://127.0.0.1:8545')).toContain('127.0.0.1');
  });

  it('rejects plaintext http to a remote host', () => {
    expect(() => assertSecureRpcUrl('http://rpc.example.org')).toThrow(/must use https/);
  });
});

describe('assertExplorerUrl', () => {
  it('strips a trailing slash so link building is predictable', () => {
    expect(assertExplorerUrl('https://bscscan.com/')).toBe('https://bscscan.com');
  });

  it('rejects http', () => {
    expect(() => assertExplorerUrl('http://bscscan.com')).toThrow(/must use https/);
  });
});

describe('assertValidBaseUnitAmount', () => {
  it('accepts a large uint256-range integer string', () => {
    expect(assertValidBaseUnitAmount('1000000000000000000')).toBe(1_000_000_000_000_000_000n);
  });

  it('rejects zero, decimals and negatives', () => {
    expect(() => assertValidBaseUnitAmount('0')).toThrow(/greater than zero/);
    expect(() => assertValidBaseUnitAmount('1.5')).toThrow(/digits only/);
    expect(() => assertValidBaseUnitAmount('-1')).toThrow(/digits only/);
  });

  it('rejects a value above uint256 max', () => {
    expect(() => assertValidBaseUnitAmount((2n ** 256n).toString())).toThrow(/uint256/);
  });
});

describe('assertValidTxHash', () => {
  const hash = `0x${'a'.repeat(64)}`;

  it('accepts a 32-byte hash', () => {
    expect(assertValidTxHash(hash)).toBe(hash);
  });

  it('rejects anything that is not 32 bytes of hex', () => {
    expect(() => assertValidTxHash('0xdeadbeef')).toThrow(/64 hexadecimal/);
    expect(() => assertValidTxHash('pending')).toThrow();
  });

  it('builds an explorer link from a hash', () => {
    expect(explorerTxUrl('https://bscscan.com/', hash)).toBe(`https://bscscan.com/tx/${hash}`);
  });
});
