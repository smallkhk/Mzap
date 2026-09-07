import { AppError } from './errors';

/**
 * Exact decimal ⇄ base-unit conversion.
 *
 * All arithmetic is BigInt. Floating point is never used anywhere on the value
 * path: `parseFloat("0.1") * 1e18` is off by 8192 wei, and a rounding error
 * here would send the wrong amount of money. The only place a Number appears
 * is `decimals`, which is a small integer from configuration.
 */

/**
 * Converts a user-entered decimal string into an integer number of base units
 * for a token with `decimals` decimal places.
 *
 * "1.5" with decimals=6  → 1500000n
 * "1"   with decimals=18 → 1000000000000000000n
 */
export function parseAmount(input: string, decimals: number, symbol = 'token'): bigint {
  const trimmed = (input ?? '').trim();

  if (!trimmed) {
    throw new AppError('AMOUNT_REQUIRED', 'Enter an amount to send.');
  }

  // Reject thousands separators and other decoration explicitly rather than
  // silently reinterpreting them — "1,5" means different things in different
  // locales and guessing would be dangerous.
  if (/[,\s]/.test(trimmed)) {
    throw new AppError(
      'AMOUNT_INVALID',
      'Enter the amount using a full stop as the decimal separator, with no spaces or commas ' +
        '(for example 12.5).',
    );
  }

  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') {
    throw new AppError(
      'AMOUNT_INVALID',
      `"${input}" is not a valid amount. Enter digits only, with at most one decimal point.`,
    );
  }

  const [wholePart = '', fractionPart = ''] = trimmed.split('.');

  if (fractionPart.length > decimals) {
    throw new AppError(
      'AMOUNT_TOO_PRECISE',
      decimals === 0
        ? `${symbol} cannot be divided — enter a whole number.`
        : `${symbol} supports at most ${decimals} decimal place${decimals === 1 ? '' : 's'}, ` +
          `but ${fractionPart.length} were entered.`,
    );
  }

  const padded = fractionPart.padEnd(decimals, '0');
  const base = BigInt(`${wholePart || '0'}${padded || ''}`);

  if (base <= 0n) {
    throw new AppError('AMOUNT_ZERO', 'Enter an amount greater than zero.');
  }

  return base;
}

/**
 * Renders base units as a decimal string with no rounding and no exponent
 * notation. Trailing fractional zeros are trimmed, but the integer part is
 * always exact.
 */
export function formatAmount(base: bigint | string, decimals: number): string {
  const value = typeof base === 'string' ? BigInt(base) : base;
  const negative = value < 0n;
  const absolute = negative ? -value : value;

  if (decimals === 0) return `${negative ? '-' : ''}${absolute.toString()}`;

  const divisor = 10n ** BigInt(decimals);
  const whole = absolute / divisor;
  const fraction = absolute % divisor;

  if (fraction === 0n) return `${negative ? '-' : ''}${whole.toString()}`;

  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}.${fractionText}`;
}

/**
 * A shortened form for dense UI (tables, balance chips). Keeps at most
 * `maxFractionDigits` and marks truncation with a leading "~" so a displayed
 * value is never mistaken for the exact one.
 */
export function formatAmountShort(
  base: bigint | string,
  decimals: number,
  maxFractionDigits = 6,
): string {
  const exact = formatAmount(base, decimals);
  const [whole = '0', fraction] = exact.split('.');

  if (!fraction || fraction.length <= maxFractionDigits) return exact;

  const truncated = fraction.slice(0, maxFractionDigits).replace(/0+$/, '');
  return truncated ? `~${whole}.${truncated}` : `~${whole}`;
}

/** Groups the integer part with thin separators for readability. */
export function withThousands(formatted: string): string {
  const [whole = '0', fraction] = formatted.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
