import { AppError } from './errors';

/**
 * Exact decimal ⇄ base-unit conversion.
 *
 * All arithmetic is BigInt. Floating point is never used anywhere on the
 * value path: `parseFloat("0.1") * 1e18` is off by 8192 wei, and a rounding
 * error here would send the wrong amount of money. The only place a Number
 * appears is `decimals`, a small integer from configuration.
 *
 * Ported verbatim from the desktop app's own lib/amount.ts, so a quote shown
 * here matches one shown there exactly.
 */

export function parseAmount(input: string, decimals: number, symbol = 'token'): bigint {
  const trimmed = (input ?? '').trim();

  if (!trimmed) {
    throw new AppError('AMOUNT_REQUIRED', 'Enter an amount to send.');
  }

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
