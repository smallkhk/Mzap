import { HDNodeWallet, Mnemonic, Wallet, getAddress } from 'ethers';
import type { WalletStatus } from '../../shared/types';
import { AppError } from '../lib/errors';
import { normalisePrivateKey } from '../lib/validation';
import * as vault from './vault';

/**
 * Wallet lifecycle: create, import, unlock, lock.
 *
 * All of this runs in the main process. The renderer can ask for an address
 * and a lock state; it can never obtain a key, and the IPC surface has no
 * channel that would return one.
 */

export async function getStatus(): Promise<WalletStatus> {
  return {
    hasWallet: await vault.hasWallet(),
    unlocked: vault.isUnlocked(),
    address: vault.isUnlocked() ? vault.currentAddress() : await vault.storedAddress(),
    osEncryptionAvailable: vault.isOsEncryptionAvailable(),
    autoLockSeconds: vault.getAutoLockSeconds(),
    // Local signing by definition; the IPC layer overrides this when the
    // backend reports that it signs on this installation's behalf.
    custodial: false,
  };
}

/**
 * Generates a brand-new wallet and returns its recovery phrase **once**, for
 * the user to write down. It is not stored anywhere in plaintext: only the
 * derived private key goes into the vault.
 */
export async function createWallet(passphrase: string): Promise<{ address: string; mnemonic: string }> {
  vault.assertPassphraseStrength(passphrase);

  if (await vault.hasWallet()) {
    throw new AppError(
      'WALLET_EXISTS',
      'A wallet already exists on this machine. Remove it in Settings before creating another — ' +
        'make sure you have its recovery phrase first.',
    );
  }

  const wallet = Wallet.createRandom();
  const address = getAddress(wallet.address);
  const key = Buffer.from(wallet.privateKey.slice(2), 'hex');

  await vault.createVault(key, address, passphrase);

  return { address, mnemonic: wallet.mnemonic!.phrase };
}

/** Imports an existing wallet from a raw private key. */
export async function importPrivateKey(
  privateKeyInput: string,
  passphrase: string,
): Promise<{ address: string }> {
  vault.assertPassphraseStrength(passphrase);

  const privateKey = normalisePrivateKey(privateKeyInput);

  let address: string;
  try {
    address = getAddress(new Wallet(privateKey).address);
  } catch {
    throw new AppError(
      'INVALID_PRIVATE_KEY',
      'That private key is not valid for this curve. Check that you copied it completely.',
    );
  }

  const key = Buffer.from(privateKey.slice(2), 'hex');
  await vault.createVault(key, address, passphrase);

  return { address };
}

/**
 * Imports from a BIP-39 recovery phrase.
 *
 * `derivationPath` defaults to the standard Ethereum account 0 path, which is
 * what MetaMask, Trust Wallet and hardware wallets use for their first
 * account.
 */
export async function importMnemonic(
  phrase: string,
  passphrase: string,
  derivationPath = "m/44'/60'/0'/0/0",
): Promise<{ address: string }> {
  vault.assertPassphraseStrength(passphrase);

  const normalised = (phrase ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const words = normalised.split(' ').filter(Boolean);

  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new AppError(
      'MNEMONIC_LENGTH',
      `A recovery phrase has 12, 15, 18, 21 or 24 words. This one has ${words.length}.`,
    );
  }

  if (!Mnemonic.isValidMnemonic(normalised)) {
    throw new AppError(
      'MNEMONIC_INVALID',
      'That recovery phrase failed its checksum, which means at least one word is wrong or out ' +
        'of order. Check each word against your written copy.',
    );
  }

  let wallet: HDNodeWallet;
  try {
    wallet = HDNodeWallet.fromPhrase(normalised, undefined, derivationPath);
  } catch {
    throw new AppError(
      'DERIVATION_PATH_INVALID',
      `"${derivationPath}" is not a valid derivation path.`,
    );
  }

  const address = getAddress(wallet.address);
  const key = Buffer.from(wallet.privateKey.slice(2), 'hex');

  await vault.createVault(key, address, passphrase);

  return { address };
}

export async function unlock(passphrase: string): Promise<{ address: string }> {
  return { address: await vault.unlock(passphrase) };
}

export function lock(): void {
  vault.lock();
}

/**
 * Deletes the wallet. Requires the current passphrase, so a locked machine
 * left unattended cannot have its vault wiped by a passer-by.
 */
export async function removeWallet(passphrase: string): Promise<void> {
  await vault.unlock(passphrase);
  await vault.destroyVault();
}
