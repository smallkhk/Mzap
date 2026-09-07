import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Wallet, getAddress } from 'ethers';
import { config } from '../config';
import { logger } from '../lib/logger';
import { AppError } from '../lib/errors';

/**
 * Custodial sending wallet.
 *
 * ── What this is, plainly ────────────────────────────────────────────────
 * In custodial mode the operator's private key lives on this server so that
 * desktop clients can send without holding a key themselves. That is a
 * deliberate trade: it buys a much simpler experience for users, and it means
 * whoever controls this server controls the funds. There is no cryptography
 * that avoids that — a machine which can sign unattended can be made to sign
 * by anyone who owns the machine.
 *
 * What this module can do is narrow the exposure:
 *
 *  - The key is stored encrypted (scrypt + AES-256-GCM), never in plaintext.
 *  - The passphrase is supplied out-of-band via WALLET_PASSPHRASE and is not
 *    written to disk by this application.
 *  - The decrypted key exists only in a module-private Buffer, is never
 *    logged, never serialised, and never leaves this process.
 *  - The vault path defaults outside the web root, and startup refuses a
 *    location that is web-served.
 *  - Spending limits (see sendService) bound what any single leaked API key
 *    can move.
 *
 * If the wallet holds more than you are willing to lose to a host compromise,
 * run this on a machine you control rather than shared hosting, and keep the
 * bulk of funds in a wallet this server has never seen.
 */

const MAGIC = 'FSSRVVAULT1';

/** scrypt cost: ~128 MiB, ~0.5–1s. Deliberately slow against offline attack. */
const KDF = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 } as const;

interface VaultFile {
  magic: typeof MAGIC;
  version: 1;
  address: string;
  createdAt: string;
  kdf: { algorithm: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { algorithm: 'aes-256-gcm'; iv: string; tag: string; data: string };
}

let unlockedKey: Buffer | null = null;
let walletAddress: string | null = null;

export const vaultPath = () => path.resolve(config.WALLET_VAULT_PATH ?? '');

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

/** Overwrite in place so the secret does not linger in the heap. */
function wipe(buffer: Buffer | null) {
  if (buffer) crypto.randomFillSync(buffer);
}

/**
 * Encrypts a private key to the vault file.
 *
 * Used by the `import-wallet` script only — never by a request handler. There
 * is no HTTP route that writes a key, so a compromised API key cannot replace
 * the wallet.
 */
export async function writeVault(
  privateKey: string,
  passphrase: string,
  targetPath: string,
): Promise<string> {
  assertPassphraseStrength(passphrase);

  let address: string;
  try {
    address = getAddress(new Wallet(privateKey).address);
  } catch {
    throw new AppError(
      400,
      'INVALID_PRIVATE_KEY',
      'That is not a valid private key. Expected 64 hexadecimal characters, optionally 0x-prefixed.',
    );
  }

  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const derived = deriveKey(passphrase, salt);
  const keyBytes = Buffer.from(privateKey.replace(/^0x/i, ''), 'hex');

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
    const sealed = Buffer.concat([cipher.update(keyBytes), cipher.final()]);

    const vault: VaultFile = {
      magic: MAGIC,
      version: 1,
      address,
      createdAt: new Date().toISOString(),
      kdf: { algorithm: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
      cipher: {
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: sealed.toString('base64'),
      },
    };

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, JSON.stringify(vault, null, 2), { mode: 0o600 });
    await fsp.chmod(targetPath, 0o600).catch(() => undefined);

    return address;
  } finally {
    wipe(derived);
    wipe(keyBytes);
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Refuses a vault stored somewhere the web server could serve.
 *
 * On cPanel the application often lives inside the document root, where a
 * misconfigured or disabled Passenger would let the file be fetched over
 * HTTP. Failing loudly at boot beats discovering that later.
 */
function assertVaultPathIsSafe(resolved: string) {
  const docRootMarkers = ['/public_html/', '/public/'];

  if (docRootMarkers.some((marker) => `${resolved}/`.includes(marker))) {
    throw new AppError(
      500,
      'VAULT_PATH_UNSAFE',
      `The wallet vault at ${resolved} is inside a web-served directory. Move it outside the ` +
        'document root and update WALLET_VAULT_PATH.',
    );
  }
}

/**
 * Loads and unlocks the wallet at startup.
 *
 * Absent configuration is not an error: the deployment simply stays in
 * local-signing mode, where each desktop installation holds its own key.
 */
export async function initialise(): Promise<void> {
  if (!config.WALLET_VAULT_PATH || !config.WALLET_PASSPHRASE) {
    logger.info('No server wallet configured — clients sign locally with their own keys.');
    return;
  }

  const resolved = vaultPath();
  assertVaultPathIsSafe(resolved);

  if (!fs.existsSync(resolved)) {
    throw new AppError(
      500,
      'VAULT_MISSING',
      `WALLET_VAULT_PATH points at ${resolved}, but no vault file exists there. ` +
        'Create one with: npm run import-wallet',
    );
  }

  const raw = await fsp.readFile(resolved, 'utf8');
  let vault: VaultFile;

  try {
    vault = JSON.parse(raw) as VaultFile;
    if (vault.magic !== MAGIC || vault.version !== 1) throw new Error('bad header');
  } catch {
    throw new AppError(
      500,
      'VAULT_UNREADABLE',
      `The wallet vault at ${resolved} is not in a recognised format.`,
    );
  }

  const derived = deriveKey(config.WALLET_PASSPHRASE, Buffer.from(vault.kdf.salt, 'base64'));

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      derived,
      Buffer.from(vault.cipher.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(vault.cipher.tag, 'base64'));

    const key = Buffer.concat([
      decipher.update(Buffer.from(vault.cipher.data, 'base64')),
      decipher.final(),
    ]);

    // Confirm the sealed key really is the address the vault claims, so a
    // swapped file is caught rather than silently signing from elsewhere.
    const derivedAddress = getAddress(new Wallet(`0x${key.toString('hex')}`).address);

    if (derivedAddress !== getAddress(vault.address)) {
      wipe(key);
      throw new AppError(
        500,
        'VAULT_ADDRESS_MISMATCH',
        'The wallet vault decrypted to a different address than it records. Refusing to start.',
      );
    }

    unlockedKey = key;
    walletAddress = derivedAddress;

    logger.info({ address: derivedAddress }, 'Server wallet unlocked — custodial sending enabled');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      500,
      'VAULT_PASSPHRASE_WRONG',
      'The wallet vault could not be decrypted. Check WALLET_PASSPHRASE.',
    );
  } finally {
    wipe(derived);
  }
}

export const isCustodial = () => unlockedKey !== null;

export function address(): string {
  if (!walletAddress) {
    throw new AppError(
      503,
      'NO_SERVER_WALLET',
      'This deployment has no server wallet configured.',
    );
  }
  return walletAddress;
}

/**
 * Runs `fn` with the decrypted key.
 *
 * The only route to the key. It is passed in, never returned, so it cannot
 * escape to a caller that might serialise it.
 */
export async function withPrivateKey<T>(fn: (privateKeyHex: string) => Promise<T>): Promise<T> {
  if (!unlockedKey) {
    throw new AppError(
      503,
      'NO_SERVER_WALLET',
      'No server wallet is available to sign this transaction.',
    );
  }
  return fn(`0x${unlockedKey.toString('hex')}`);
}

export function lock(): void {
  wipe(unlockedKey);
  unlockedKey = null;
  walletAddress = null;
}

export function assertPassphraseStrength(passphrase: string): void {
  const problems: string[] = [];

  if (passphrase.length < 16) problems.push('be at least 16 characters long');
  if (!/[a-z]/.test(passphrase)) problems.push('contain a lowercase letter');
  if (!/[A-Z]/.test(passphrase)) problems.push('contain an uppercase letter');
  if (!/[0-9]/.test(passphrase)) problems.push('contain a digit');

  if (problems.length) {
    throw new AppError(
      400,
      'WEAK_PASSPHRASE',
      `The vault passphrase must ${problems.join(', ')}. This passphrase is the only thing ` +
        'protecting the key if the vault file is copied off the server.',
    );
  }
}
