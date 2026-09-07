import { getAddress, isAddress } from 'ethers';

/**
 * Chain-level validation helpers.
 *
 * These run on the backend so a malformed contract address can never be
 * *stored*, and again on the desktop client so a malformed one can never be
 * *used* even if the backend were compromised. Validating in both places is
 * deliberate: the client does not trust the server's output blindly.
 */

/** The zero address — never a valid recipient or token contract. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Normalise an EVM address to its EIP-55 checksummed form.
 * Throws with a specific reason so the UI can explain what is wrong.
 */
export function normaliseAddress(value: string, label = 'Address'): string {
  const raw = (value ?? '').trim();

  if (!raw) throw new Error(`${label} is required.`);
  if (!raw.startsWith('0x')) throw new Error(`${label} must start with "0x".`);
  if (raw.length !== 42) {
    throw new Error(
      `${label} must be exactly 42 characters (0x followed by 40 hex characters); received ${raw.length}.`,
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${label} contains characters that are not valid hexadecimal.`);
  }
  if (!isAddress(raw)) {
    // Reachable when the string is mixed-case with a bad EIP-55 checksum.
    throw new Error(
      `${label} has an invalid checksum. It may have been mistyped or truncated — ` +
        `re-copy it from the source.`,
    );
  }
  if (raw.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${label} cannot be the zero address.`);
  }

  return getAddress(raw);
}

/** True when `value` is a usable EVM address (without throwing). */
export function isValidAddress(value: string): boolean {
  try {
    normaliseAddress(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * EVM chain ids are positive integers. EIP-155 bounds them well below
 * 2^64; anything larger is a configuration error rather than a real chain.
 */
export const MAX_CHAIN_ID = Number.MAX_SAFE_INTEGER;

export function assertValidChainId(chainId: number): number {
  if (!Number.isInteger(chainId)) {
    throw new Error('Chain ID must be a whole number.');
  }
  if (chainId <= 0) {
    throw new Error('Chain ID must be greater than zero.');
  }
  if (chainId > MAX_CHAIN_ID) {
    throw new Error(`Chain ID ${chainId} is outside the range of valid EVM chain IDs.`);
  }
  return chainId;
}

/** ERC-20 `decimals()` returns a uint8; values above 36 are not real tokens. */
export function assertValidDecimals(decimals: number): number {
  if (!Number.isInteger(decimals)) {
    throw new Error('Token decimals must be a whole number.');
  }
  if (decimals < 0 || decimals > 36) {
    throw new Error('Token decimals must be between 0 and 36.');
  }
  return decimals;
}

/**
 * Only https/wss RPC endpoints are accepted. A plaintext RPC URL would let a
 * network attacker rewrite balances and gas prices shown to the user.
 */
export function assertSecureRpcUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }

  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);

  if (!['https:', 'wss:'].includes(parsed.protocol) && !isLoopback) {
    throw new Error(
      `RPC endpoint "${url}" must use https:// or wss://. Plaintext RPC is only ` +
        `permitted for loopback addresses during development.`,
    );
  }
  return parsed.toString();
}

/** Explorer base URLs must be https so the "View on explorer" link is safe. */
export function assertExplorerUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Explorer URL "${url}" must use https://.`);
  }
  // Normalise away a trailing slash so link building is predictable.
  return parsed.toString().replace(/\/+$/, '');
}

/** A uint256 base-unit amount, transported as a decimal string. */
export const UINT256_MAX = (1n << 256n) - 1n;

export function assertValidBaseUnitAmount(value: string, label = 'Amount'): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a whole number of base units, expressed as digits only.`);
  }
  const parsedValue = BigInt(value);
  if (parsedValue <= 0n) throw new Error(`${label} must be greater than zero.`);
  if (parsedValue > UINT256_MAX) throw new Error(`${label} exceeds the maximum uint256 value.`);
  return parsedValue;
}

/** A 32-byte transaction hash as returned by an EVM node. */
export function assertValidTxHash(hash: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(
      'Transaction hash must be 0x followed by 64 hexadecimal characters, as returned by the node.',
    );
  }
  return hash.toLowerCase();
}

/** Build a canonical explorer link for a transaction. */
export function explorerTxUrl(explorerBase: string, txHash: string): string {
  return `${explorerBase.replace(/\/+$/, '')}/tx/${txHash}`;
}

/** Build a canonical explorer link for an address. */
export function explorerAddressUrl(explorerBase: string, address: string): string {
  return `${explorerBase.replace(/\/+$/, '')}/address/${address}`;
}
