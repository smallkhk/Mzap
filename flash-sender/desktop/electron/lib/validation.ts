import { getAddress, isAddress } from 'ethers';
import { AppError } from './errors';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Recipient address validation.
 *
 * Each failure mode gets its own message, because "invalid address" tells the
 * user nothing about which of these went wrong — and a mistyped recipient is
 * the single most expensive mistake available in this application.
 */
export function validateRecipient(input: string, senderAddress?: string): string {
  const raw = (input ?? '').trim();

  if (!raw) {
    throw new AppError('RECIPIENT_REQUIRED', 'Enter the recipient address.');
  }

  if (raw.endsWith('.eth') || raw.endsWith('.bnb') || raw.endsWith('.crypto')) {
    throw new AppError(
      'ENS_NOT_SUPPORTED',
      'Name-service addresses are not supported. Paste the recipient\'s 0x… address instead, ' +
        'resolved from a source you trust.',
    );
  }

  if (!raw.startsWith('0x')) {
    throw new AppError(
      'RECIPIENT_MALFORMED',
      'A recipient address must start with "0x". Check that you pasted the whole address.',
    );
  }

  if (raw.length !== 42) {
    throw new AppError(
      'RECIPIENT_MALFORMED',
      `A recipient address is 42 characters long (0x followed by 40 hex characters), but this ` +
        `one is ${raw.length}. It may have been truncated when copying.`,
    );
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new AppError(
      'RECIPIENT_MALFORMED',
      'The recipient address contains characters that are not valid hexadecimal digits (0–9, a–f).',
    );
  }

  if (raw.toLowerCase() === ZERO_ADDRESS) {
    throw new AppError(
      'RECIPIENT_ZERO_ADDRESS',
      'That is the zero address. Funds sent there are permanently destroyed and cannot be ' +
        'recovered.',
    );
  }

  if (!isAddress(raw)) {
    throw new AppError(
      'RECIPIENT_BAD_CHECKSUM',
      'This address has mixed capitalisation but fails its EIP-55 checksum, which means at least ' +
        'one character is wrong. Re-copy the address from its source rather than retyping it.',
    );
  }

  const normalised = getAddress(raw);

  if (senderAddress && normalised.toLowerCase() === senderAddress.toLowerCase()) {
    throw new AppError(
      'RECIPIENT_IS_SENDER',
      'The recipient is the same as the sending wallet. This would only pay a network fee to ' +
        'send funds back to yourself.',
    );
  }

  return normalised;
}

/**
 * Normalises a private key the user pastes in during wallet import.
 * Accepts with or without the 0x prefix, and rejects a mnemonic with a
 * pointer to the right field rather than a generic parse error.
 */
export function normalisePrivateKey(input: string): string {
  const raw = (input ?? '').trim();

  if (!raw) {
    throw new AppError('PRIVATE_KEY_REQUIRED', 'Enter the private key to import.');
  }

  if (raw.split(/\s+/).length >= 12) {
    throw new AppError(
      'MNEMONIC_SUPPLIED',
      'That looks like a recovery phrase rather than a private key. Use the "Recovery phrase" ' +
        'tab to import it.',
    );
  }

  const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new AppError(
      'PRIVATE_KEY_MALFORMED',
      `A private key is 64 hexadecimal characters, optionally prefixed with 0x. This input is ` +
        `${hex.length} characters.`,
    );
  }

  if (/^0+$/.test(hex)) {
    throw new AppError('PRIVATE_KEY_MALFORMED', 'That is not a usable private key.');
  }

  return `0x${hex.toLowerCase()}`;
}
