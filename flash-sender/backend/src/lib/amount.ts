import { AppError } from './errors';

/**
 * Exact decimal ⇄ base-unit conversion.
 *
 * All arithmetic is BigInt. Floating point is never used on the value path:
 * `parseFloat("0.1") * 1e18` is off by 8192 wei, and a rounding error here
 * would send the wrong amount of money. The only Number involved is
 * `decimals`, a small integer from configuration.
 *
 * This mirrors the desktop client's implementation exactly, so a quote shown
 * in the app and the amount signed on the server are computed identically.
 */

export function parseAmount(input: string, decimals: number, symbol = 'token'): bigint {
  const trimmed = (input ?? '').trim();

  if (!trimmed) {
    throw new AppError(400, 'AMOUNT_REQUIRED', 'Enter an amount to send.');
  }

  // Reject thousands separators rather than reinterpreting them — "1,5" means
  // different things in different locales and guessing would be dangerous.
  if (/[,\s]/.test(trimmed)) {
    throw new AppError(
      400,
      'AMOUNT_INVALID',
      'Enter the amount using a full stop as the decimal separator, with no spaces or commas.',
    );
  }

  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') {
    throw new AppError(
      400,
      'AMOUNT_INVALID',
      `"${input}" is not a valid amount. Enter digits only, with at most one decimal point.`,
    );
  }

  const [wholePart = '', fractionPart = ''] = trimmed.split('.');

  if (fractionPart.length > decimals) {
    throw new AppError(
      400,
      'AMOUNT_TOO_PRECISE',
      decimals === 0
        ? `${symbol} cannot be divided — enter a whole number.`
        : `${symbol} supports at most ${decimals} decimal place${decimals === 1 ? '' : 's'}, ` +
          `but ${fractionPart.length} were entered.`,
    );
  }

  const base = BigInt(`${wholePart || '0'}${fractionPart.padEnd(decimals, '0')}`);

  if (base <= 0n) {
    throw new AppError(400, 'AMOUNT_ZERO', 'Enter an amount greater than zero.');
  }

  return base;
}

/** Renders base units as an exact decimal string — no rounding, no exponent. */
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

/** Shortened form for display; marks truncation so it is not read as exact. */
export function formatAmountShort(
  base: bigint | string,
  decimals: number,
  maxFractionDigits = 8,
): string {
  const exact = formatAmount(base, decimals);
  const [whole = '0', fraction] = exact.split('.');

  if (!fraction || fraction.length <= maxFractionDigits) return exact;

  const truncated = fraction.slice(0, maxFractionDigits).replace(/0+$/, '');
  return truncated ? `~${whole}.${truncated}` : `~${whole}`;
}
