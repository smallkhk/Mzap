import { app, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../lib/errors';

/**
 * Encrypted wallet vault.
 *
 * Threat model and design
 * -----------------------
 * The signing key must survive at rest on a Windows machine and must never
 * leave this process. Two independent layers protect it:
 *
 *  1. **Passphrase layer.** The key is sealed with AES-256-GCM using a key
 *     derived from a user passphrase via scrypt (N=2^17). Without the
 *     passphrase the ciphertext is useless even to someone holding the file.
 *
 *  2. **OS layer.** The result is then wrapped with Electron's `safeStorage`,
 *     which on Windows is DPAPI bound to the current user account. Copying the
 *     vault file to another machine or another Windows user renders it
 *     undecryptable regardless of the passphrase.
 *
 * The decrypted key exists only in a module-private variable, only while the
 * vault is unlocked, and is zeroed on lock. It is never written to disk in
 * plaintext, never logged, never placed on an IPC channel, and never sent to
 * the backend — there is no code path in this application that transmits it
 * anywhere.
 *
 * What is stored in the file: the sealed key, the address it corresponds to,
 * the KDF parameters, and a creation timestamp. Nothing else.
 */

const VAULT_FILE = 'wallet.vault';
const MAGIC = 'FSVAULT1';

/** scrypt cost. N=131072 with r=8 costs ~128 MiB and ~0.5–1s — deliberately slow. */
const KDF = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 } as const;

interface VaultFile {
  magic: typeof MAGIC;
  version: 1;
  address: string;
  createdAt: string;
  /** Whether the payload below is additionally wrapped by safeStorage/DPAPI. */
  osWrapped: boolean;
  kdf: { algorithm: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { algorithm: 'aes-256-gcm'; iv: string; tag: string; data: string };
}

let unlockedKey: Buffer | null = null;
let unlockedAddress: string | null = null;
let lastActivityAt = 0;
let autoLockSeconds = 300;
let lockTimer: NodeJS.Timeout | null = null;

const vaultPath = () => path.join(app.getPath('userData'), VAULT_FILE);

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

async function readVaultFile(): Promise<VaultFile | null> {
  try {
    const raw = await fs.readFile(vaultPath(), 'utf8');
    const parsed = JSON.parse(raw) as VaultFile;
    if (parsed.magic !== MAGIC || parsed.version !== 1) {
      throw new AppError(
        'VAULT_UNREADABLE',
        'The wallet vault file is not in a recognised format. It may be from a newer version of the app.',
      );
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof AppError) throw err;
    throw new AppError(
      'VAULT_UNREADABLE',
      'The wallet vault file could not be read and may be corrupted. Restore a backup, or ' +
        'remove it and re-import your wallet.',
      err instanceof Error ? err.message : undefined,
    );
  }
}

async function writeVaultFile(vault: VaultFile): Promise<void> {
  const target = vaultPath();
  const tmp = `${target}.tmp`;

  // Write-then-rename so an interrupted write cannot truncate an existing vault.
  await fs.writeFile(tmp, JSON.stringify(vault, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);

  // Best-effort on Windows, where POSIX modes are advisory.
  await fs.chmod(target, 0o600).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, KDF.keylen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: KDF.maxmem,
  });
}

/** Overwrite a buffer in place so the secret does not linger in the heap. */
function wipe(buffer: Buffer | null) {
  if (buffer) crypto.randomFillSync(buffer);
}

function osWrap(payload: Buffer): { data: Buffer; wrapped: boolean } {
  if (!safeStorage.isEncryptionAvailable()) return { data: payload, wrapped: false };
  return { data: safeStorage.encryptString(payload.toString('base64')), wrapped: true };
}

function osUnwrap(data: Buffer, wrapped: boolean): Buffer {
  if (!wrapped) return data;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new AppError(
      'OS_ENCRYPTION_UNAVAILABLE',
      'This vault is protected by Windows account encryption, which is not available right now. ' +
        'Sign in as the Windows user that created the vault.',
    );
  }
  return Buffer.from(safeStorage.decryptString(data), 'base64');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isOsEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export async function hasWallet(): Promise<boolean> {
  return (await readVaultFile()) !== null;
}

export async function storedAddress(): Promise<string | null> {
  return (await readVaultFile())?.address ?? null;
}

export function isUnlocked(): boolean {
  return unlockedKey !== null;
}

export function currentAddress(): string | null {
  return unlockedAddress;
}

export function setAutoLockSeconds(seconds: number) {
  autoLockSeconds = Math.max(30, Math.min(3600, Math.floor(seconds)));
  if (isUnlocked()) scheduleAutoLock();
}

export function getAutoLockSeconds(): number {
  return autoLockSeconds;
}

/**
 * Seals a private key into a new vault, replacing any existing one.
 *
 * `privateKey` is consumed and wiped here; the caller must not retain it.
 */
export async function createVault(
  privateKey: Buffer,
  address: string,
  passphrase: string,
): Promise<void> {
  assertPassphraseStrength(passphrase);

  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const derived = deriveKey(passphrase, salt);

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
    const sealed = Buffer.concat([cipher.update(privateKey), cipher.final()]);
    const tag = cipher.getAuthTag();

    const { data, wrapped } = osWrap(sealed);

    await writeVaultFile({
      magic: MAGIC,
      version: 1,
      address,
      createdAt: new Date().toISOString(),
      osWrapped: wrapped,
      kdf: { algorithm: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
      cipher: {
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: data.toString('base64'),
      },
    });
  } finally {
    wipe(derived);
    wipe(privateKey);
  }
}

/**
 * Unlocks the vault into memory. Returns the address so the caller can
 * confirm it matches what the vault claims.
 */
export async function unlock(passphrase: string): Promise<string> {
  const vault = await readVaultFile();
  if (!vault) {
    throw new AppError(
      'NO_WALLET',
      'No wallet has been set up yet. Import a wallet before sending.',
    );
  }

  const derived = deriveKey(passphrase, Buffer.from(vault.kdf.salt, 'base64'));

  try {
    const sealed = osUnwrap(Buffer.from(vault.cipher.data, 'base64'), vault.osWrapped);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      derived,
      Buffer.from(vault.cipher.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(vault.cipher.tag, 'base64'));

    const key = Buffer.concat([decipher.update(sealed), decipher.final()]);

    unlockedKey = key;
    unlockedAddress = vault.address;
    touch();
    scheduleAutoLock();

    return vault.address;
  } catch (err) {
    if (err instanceof AppError) throw err;
    // GCM tag failure is indistinguishable from a wrong passphrase, which is
    // exactly what we want to report.
    throw new AppError(
      'WRONG_PASSPHRASE',
      'That passphrase is incorrect. The wallet remains locked.',
    );
  } finally {
    wipe(derived);
  }
}

export function lock(): void {
  wipe(unlockedKey);
  unlockedKey = null;
  unlockedAddress = null;
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
}

/** Permanently deletes the vault file. */
export async function destroyVault(): Promise<void> {
  lock();
  await fs.rm(vaultPath(), { force: true });
  await fs.rm(`${vaultPath()}.tmp`, { force: true });
}

/**
 * Runs `fn` with the decrypted key.
 *
 * This is the *only* way the key is reachable, and it is scoped to a single
 * synchronous-or-awaited callback inside the main process. The key is not
 * returned, so it cannot escape to a caller that might forward it onward.
 */
export async function withPrivateKey<T>(fn: (key: Buffer) => Promise<T> | T): Promise<T> {
  if (!unlockedKey) {
    throw new AppError(
      'WALLET_LOCKED',
      'The wallet is locked. Unlock it with your passphrase to continue.',
    );
  }
  touch();
  return fn(unlockedKey);
}

/** Records activity so the inactivity timer restarts. */
export function touch(): void {
  lastActivityAt = Date.now();
}

function scheduleAutoLock() {
  if (lockTimer) clearTimeout(lockTimer);

  lockTimer = setInterval(() => {
    if (!isUnlocked()) return;
    if (Date.now() - lastActivityAt >= autoLockSeconds * 1000) {
      lock();
      onAutoLock?.();
    }
  }, 5_000);
}

let onAutoLock: (() => void) | undefined;

export function setAutoLockCallback(fn: () => void) {
  onAutoLock = fn;
}

/**
 * Passphrase policy. The vault's resistance to an offline attack against a
 * stolen file rests on this, so it is enforced rather than advised.
 */
export function assertPassphraseStrength(passphrase: string): void {
  const problems: string[] = [];

  if (passphrase.length < 12) problems.push('be at least 12 characters long');
  if (!/[a-z]/.test(passphrase)) problems.push('contain a lowercase letter');
  if (!/[A-Z]/.test(passphrase)) problems.push('contain an uppercase letter');
  if (!/[0-9]/.test(passphrase)) problems.push('contain a digit');

  if (problems.length) {
    throw new AppError(
      'WEAK_PASSPHRASE',
      `Your vault passphrase must ${problems.join(', ')}. This passphrase is what protects ` +
        'your key if the vault file is ever copied off this machine.',
    );
  }
}
