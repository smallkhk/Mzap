import { describe, expect, it } from 'vitest';
import { formatAmount, formatAmountShort, parseAmount, withThousands } from '../electron/lib/amount';

/**
 * These tests guard the single most dangerous conversion in the application.
 * An error of one decimal place here is an error of 10x in the amount sent.
 */
describe('parseAmount', () => {
  it('converts whole numbers at 18 decimals', () => {
    expect(parseAmount('1', 18)).toBe(1_000_000_000_000_000_000n);
    expect(parseAmount('100', 18)).toBe(100_000_000_000_000_000_000n);
  });

  it('converts fractional values at 6 decimals (USDT-style)', () => {
    expect(parseAmount('1.5', 6)).toBe(1_500_000n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
    expect(parseAmount('1234.567891', 6)).toBe(1_234_567_891n);
  });

  it('pads a short fraction rather than truncating it', () => {
    expect(parseAmount('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseAmount('0.1', 18)).toBe(100_000_000_000_000_000n);
  });

  it('is exact where floating point is not', () => {
    // parseFloat('0.1') * 1e18 === 100000000000000000000 * 1.0000000000000000?
    // In IEEE-754 this produces 100000000000000000 ± error. BigInt does not.
    expect(parseAmount('0.1', 18)).toBe(10n ** 17n);
    expect(parseAmount('0.3', 18)).toBe(3n * 10n ** 17n);
    expect(parseAmount('1.005', 18)).toBe(1_005_000_000_000_000_000n);
  });

  it('handles a leading decimal point', () => {
    expect(parseAmount('.5', 8)).toBe(50_000_000n);
  });

  it('handles zero-decimal tokens', () => {
    expect(parseAmount('42', 0)).toBe(42n);
    expect(() => parseAmount('42.5', 0)).toThrow(/cannot be divided/);
  });

  it('rejects more precision than the token supports', () => {
    expect(() => parseAmount('1.1234567', 6, 'USDT')).toThrow(
      /USDT supports at most 6 decimal places, but 7 were entered/,
    );
  });

  it('rejects an empty or zero amount', () => {
    expect(() => parseAmount('', 18)).toThrow(/Enter an amount/);
    expect(() => parseAmount('0', 18)).toThrow(/greater than zero/);
    expect(() => parseAmount('0.0', 18)).toThrow(/greater than zero/);
  });

  it('rejects thousands separators rather than guessing intent', () => {
    expect(() => parseAmount('1,5', 18)).toThrow(/full stop as the decimal separator/);
    expect(() => parseAmount('1 000', 18)).toThrow(/full stop as the decimal separator/);
  });

  it('rejects malformed input', () => {
    expect(() => parseAmount('abc', 18)).toThrow(/not a valid amount/);
    expect(() => parseAmount('1.2.3', 18)).toThrow(/not a valid amount/);
    expect(() => parseAmount('-1', 18)).toThrow(/not a valid amount/);
    expect(() => parseAmount('.', 18)).toThrow(/not a valid amount/);
  });

  it('handles very large values without loss', () => {
    const oneBillion = parseAmount('1000000000', 18);
    expect(oneBillion).toBe(10n ** 27n);
  });
});

describe('formatAmount', () => {
  it('round-trips with parseAmount', () => {
    for (const [value, decimals] of [
      ['1', 18],
      ['1.5', 6],
      ['0.000001', 6],
      ['1234.5678', 8],
      ['999999.999999999999999999', 18],
    ] as [string, number][]) {
      expect(formatAmount(parseAmount(value, decimals), decimals)).toBe(value);
    }
  });

  it('trims trailing fractional zeros', () => {
    expect(formatAmount(1_500_000n, 6)).toBe('1.5');
    expect(formatAmount(1_000_000n, 6)).toBe('1');
  });

  it('formats sub-unit values with a leading zero', () => {
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001');
    expect(formatAmount(1n, 6)).toBe('0.000001');
  });

  it('never uses exponent notation', () => {
    expect(formatAmount(1n, 18)).not.toMatch(/e/i);
    expect(formatAmount(10n ** 30n, 18)).not.toMatch(/e/i);
  });

  it('handles zero decimals', () => {
    expect(formatAmount(42n, 0)).toBe('42');
  });

  it('accepts a decimal string as input', () => {
    expect(formatAmount('1500000', 6)).toBe('1.5');
  });
});

describe('formatAmountShort', () => {
  it('leaves short values exact and unmarked', () => {
    expect(formatAmountShort(1_500_000n, 6)).toBe('1.5');
  });

  it('marks truncated values so they are not mistaken for exact', () => {
    const value = parseAmount('1.123456789', 18);
    expect(formatAmountShort(value, 18, 4)).toBe('~1.1234');
  });

  it('collapses to the whole part when the fraction rounds away', () => {
    expect(formatAmountShort(parseAmount('1.0000001', 18), 18, 4)).toBe('~1');
  });
});

describe('withThousands', () => {
  it('groups the integer part only', () => {
    expect(withThousands('1234567.891')).toBe('1,234,567.891');
    expect(withThousands('999')).toBe('999');
    expect(withThousands('1000')).toBe('1,000');
  });
});
