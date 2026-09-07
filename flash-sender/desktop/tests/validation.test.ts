import { describe, expect, it } from 'vitest';
import { getAddress } from 'ethers';
import { normalisePrivateKey, validateRecipient } from '../electron/lib/validation';

const VALID = getAddress('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d');

describe('validateRecipient', () => {
  it('accepts and checksums a valid address', () => {
    expect(validateRecipient('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d')).toBe(VALID);
  });

  it('trims surrounding whitespace from a paste', () => {
    expect(validateRecipient(`  ${VALID}\n`)).toBe(VALID);
  });

  it('gives a distinct message for each failure mode', () => {
    expect(() => validateRecipient('')).toThrow(/Enter the recipient address/);
    expect(() => validateRecipient('vitalik.eth')).toThrow(/Name-service addresses are not supported/);
    expect(() => validateRecipient('8ac76a51cc950d9822d68b83fe1ad97b32cd580d')).toThrow(
      /must start with "0x"/,
    );
    expect(() => validateRecipient('0x8ac76a51')).toThrow(/42 characters/);
    expect(() => validateRecipient(`0x${'z'.repeat(40)}`)).toThrow(/not valid hexadecimal/);
    expect(() => validateRecipient(`0x${'0'.repeat(40)}`)).toThrow(/permanently destroyed/);
  });

  it('catches a bad EIP-55 checksum, which is how typos are detected', () => {
    const flipped = VALID.slice(0, -1) + (VALID.slice(-1) === 'D' ? 'd' : 'D');
    expect(() => validateRecipient(flipped)).toThrow(/fails its EIP-55 checksum/);
  });

  it('refuses a self-send, which would only burn a fee', () => {
    expect(() => validateRecipient(VALID, VALID)).toThrow(/same as the sending wallet/);
    expect(() => validateRecipient(VALID, VALID.toLowerCase())).toThrow(/same as the sending wallet/);
  });

  it('allows a different recipient when a sender is supplied', () => {
    const other = getAddress('0x55d398326f99059ff775485246999027b3197955');
    expect(validateRecipient(other, VALID)).toBe(other);
  });
});

describe('normalisePrivateKey', () => {
  const key = 'a'.repeat(64);

  it('accepts a key with or without 0x and normalises it', () => {
    expect(normalisePrivateKey(key)).toBe(`0x${key}`);
    expect(normalisePrivateKey(`0x${key}`)).toBe(`0x${key}`);
    expect(normalisePrivateKey(`0X${'A'.repeat(64)}`)).toBe(`0x${key}`);
  });

  it('points a pasted recovery phrase at the right field', () => {
    const phrase = Array(12).fill('abandon').join(' ');
    expect(() => normalisePrivateKey(phrase)).toThrow(/looks like a recovery phrase/);
  });

  it('rejects wrong-length and non-hex input with the expected length', () => {
    expect(() => normalisePrivateKey('0xdeadbeef')).toThrow(/64 hexadecimal characters/);
    expect(() => normalisePrivateKey('z'.repeat(64))).toThrow(/64 hexadecimal characters/);
  });

  it('rejects an all-zero key', () => {
    expect(() => normalisePrivateKey('0'.repeat(64))).toThrow(/not a usable private key/);
  });

  it('requires input', () => {
    expect(() => normalisePrivateKey('  ')).toThrow(/Enter the private key/);
  });
});
