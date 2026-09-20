import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HDNodeWallet, Mnemonic, getAddress } from 'ethers';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { logger } from '../lib/logger';
import { AppError } from '../lib/errors';
import { prisma } from '../lib/db';

/**
 * Per-client buy-wallet derivation.
 *
 * Deliberately a separate subsystem from `serverWallet.ts`, not a shared
 * key: the existing custodial wallet is one address every client sends
 * *from* with your permission. This is the opposite shape — every
 * portal-enabled client gets its *own* address to fund and buy from, so
 * customers holding balances doesn't mean customers holding keys.
 *
 * That still means custody of real money, so it follows the same rule as
 * the existing wallet: one seed lives encrypted on disk (scrypt + AES-256-
 * GCM, identical parameters to serverWallet's vault), the decrypted seed
 * exists only in a module-private buffer, and every child private key is
 * *derived on demand and never stored* — including never cached in memory
 * beyond the single signing call that needed it. Compromising this vault
 * compromises every client's buy-wallet, exactly as compromising the other
 * vault compromises the shared wallet; there is no way around that for an
 * unattended signer, only around leaving plaintext keys lying about.
 *
 * Derivation path: m/44'/60'/0'/0/{index}, one BIP-44 Ethereum account tree,
 * a fresh leaf per client. `index` is assigned once, stored on the client
 * row, and never reused even if the client is later revoked — reusing an
 * index would mean a new client inheriting a former client's address and,
 * with it, anything still sitting in it un-swept.
 */

const MAGIC = 'FSBUYSEED1';
const DERIVATION_BASE = "m/44'/60'/0'/0";

const KDF = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 } as const;

interface VaultFile {
  magic: typeof MAGIC;
  version: 1;
  createdAt: string;
  kdf: { algorithm: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { algorithm: 'aes-256-gcm'; iv: string; tag: string; data: string };
}

let unlockedEntropy: Buffer | null = null;

export const vaultPath = () => path.resolve(config.BUY_WALLET_VAULT_PATH ?? '');

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, KDF.keylen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: KDF.maxmem,
  });
}

function wipe(buffer: Buffer | null) {
  if (buffer) crypto.randomFillSync(buffer);
}

function assertVaultPathIsSafe(resolved: string) {
  const docRootMarkers = ['/public_html/', '/public/'];
  if (docRootMarkers.some((marker) => `${resolved}/`.includes(marker))) {
    throw new AppError(
      500,
      'VAULT_PATH_UNSAFE',
      `The buy-wallet vault at ${resolved} is inside a web-served directory. Move it outside ` +
        'the document root and update BUY_WALLET_VAULT_PATH.',
    );
  }
}

/**
 * Seals a fresh or imported 24-word mnemonic's entropy to a vault file.
 * Used by `import-buy-seed.ts` only — there is no HTTP route that writes
 * this file.
 */
export async function writeVault(
  mnemonicPhrase: string,
  passphrase: string,
  targetPath: string,
): Promise<void> {
  assertPassphraseStrength(passphrase);

  let mnemonic: Mnemonic;
  try {
    mnemonic = Mnemonic.fromPhrase(mnemonicPhrase.trim().toLowerCase().replace(/\s+/g, ' '));
  } catch {
    throw new AppError(
      400,
      'INVALID_MNEMONIC',
      'That is not a valid BIP-39 recovery phrase.',
    );
  }

  const entropy = Buffer.from(mnemonic.entropy.slice(2), 'hex');
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const derived = deriveKey(passphrase, salt);

  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
    const sealed = Buffer.concat([cipher.update(entropy), cipher.final()]);

    const vault: VaultFile = {
      magic: MAGIC,
      version: 1,
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
  } finally {
    wipe(derived);
    wipe(entropy);
  }
}

/** Absent configuration means the buy feature is simply off — not an error. */
export async function initialise(): Promise<void> {
  if (!config.BUY_WALLET_VAULT_PATH || !config.BUY_WALLET_PASSPHRASE) {
    logger.info('No buy-wallet seed configured — "Generate tokens" stays disabled.');
    return;
  }

  const resolved = vaultPath();
  assertVaultPathIsSafe(resolved);

  if (!fs.existsSync(resolved)) {
    throw new AppError(
      500,
      'BUY_VAULT_MISSING',
      `BUY_WALLET_VAULT_PATH points at ${resolved}, but no vault file exists there. ` +
        'Create one with: npm run import-buy-seed',
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
      'BUY_VAULT_UNREADABLE',
      `The buy-wallet vault at ${resolved} is not in a recognised format.`,
    );
  }

  const derived = deriveKey(config.BUY_WALLET_PASSPHRASE, Buffer.from(vault.kdf.salt, 'base64'));

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      derived,
      Buffer.from(vault.cipher.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(vault.cipher.tag, 'base64'));

    const entropy = Buffer.concat([
      decipher.update(Buffer.from(vault.cipher.data, 'base64')),
      decipher.final(),
    ]);

    // Confirm the seed actually derives — a corrupt-but-authenticated
    // decrypt would otherwise fail later, mid-swap, rather than at startup.
    Mnemonic.fromEntropy(entropy);

    unlockedEntropy = entropy;
    logger.info('Buy-wallet seed unlocked — customer "Generate tokens" enabled.');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      500,
      'BUY_VAULT_PASSPHRASE_WRONG',
      'The buy-wallet vault could not be decrypted. Check BUY_WALLET_PASSPHRASE.',
    );
  } finally {
    wipe(derived);
  }
}

export const isEnabled = () => unlockedEntropy !== null;

function requireEntropy(): Buffer {
  if (!unlockedEntropy) {
    throw new AppError(
      503,
      'BUY_WALLETS_DISABLED',
      'Buying tokens is not configured on this deployment.',
    );
  }
  return unlockedEntropy;
}

/** Derives child index `n`'s wallet. Address is safe to cache; the key is not. */
function deriveChild(index: number): HDNodeWallet {
  const mnemonic = Mnemonic.fromEntropy(requireEntropy());
  const root = HDNodeWallet.fromMnemonic(mnemonic, DERIVATION_BASE);
  return root.deriveChild(index);
}

export function deriveAddress(index: number): string {
  return getAddress(deriveChild(index).address);
}

/**
 * Runs `fn` with the private key for one client's derived wallet. The only
 * route to it — passed in, never returned, exactly like
 * `serverWallet.withPrivateKey`.
 */
export async function withDerivedKey<T>(
  index: number,
  fn: (privateKeyHex: string) => Promise<T>,
): Promise<T> {
  // ethers holds a derived key in a JS string, which — unlike the Buffer the
  // shared wallet's key lives in — cannot be actively wiped. Deriving fresh
  // on every call and holding no reference beyond this function's scope is
  // what bounds its lifetime here.
  return fn(deriveChild(index).privateKey);
}

/**
 * Idempotently assigns and returns a client's buy-wallet address, deriving
 * and generating it on first call. The index is claimed inside one
 * transaction so two concurrent "generate wallet" requests for different
 * clients can never collide, and a retried call for the same client is a
 * no-op that returns the address already on record.
 */
/**
 * Guarantees the singleton settings row exists, tolerating a concurrent
 * caller doing the same thing. Deliberately outside any transaction: two
 * inserts racing here just means one hits the unique constraint and is
 * ignored, rather than one of them retrying inside a transaction whose
 * snapshot was already taken and cannot see what the other just committed
 * — that retry-inside-a-stale-snapshot shape is what actually causes a
 * "record not found" surprise under MySQL's default isolation, not the
 * race itself.
 */
async function ensureSettingsRowExists(): Promise<void> {
  await prisma.appSetting
    .upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
    .catch((err) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    });
}

/**
 * Atomically claims the next derivation index. A plain `update` with
 * `increment`, not an upsert — by the time this runs the row is guaranteed
 * to exist, so there is nothing left to race on: MySQL serialises
 * concurrent updates to the same row via its own row lock.
 */
async function claimNextIndex(): Promise<number> {
  const settings = await prisma.appSetting.update({
    where: { id: 1 },
    data: { nextBuyWalletIndex: { increment: 1 } },
  });
  return settings.nextBuyWalletIndex - 1;
}

export async function ensureWalletFor(clientId: string): Promise<string> {
  const existing = await prisma.apiClient.findUniqueOrThrow({ where: { id: clientId } });
  if (existing.buyWalletAddress) return existing.buyWalletAddress;

  requireEntropy();

  await ensureSettingsRowExists();
  const index = await claimNextIndex();
  const address = deriveAddress(index);

  // Guards against a double-click racing itself: two concurrent calls for
  // the *same* client would otherwise both pass the check above, each claim
  // a distinct index, and then race to write the row — whichever writes
  // second would win, silently orphaning the first index (wasted, but never
  // reused, so still harmless) rather than the two calls ever disagreeing
  // about which address is "the" one. The `buyWalletAddress: null` guard
  // makes only the first write actually apply; the loser detects that via
  // `count === 0` and returns the winner's address instead of its own.
  const result = await prisma.apiClient.updateMany({
    where: { id: clientId, buyWalletAddress: null },
    data: { buyWalletIndex: index, buyWalletAddress: address },
  });

  if (result.count === 0) {
    const winner = await prisma.apiClient.findUniqueOrThrow({ where: { id: clientId } });
    logger.info({ clientId, index }, 'Lost a concurrent buy-wallet assignment; index unused');
    return winner.buyWalletAddress!;
  }

  logger.info({ clientId, index }, 'Assigned a buy-wallet address to a client');
  return address;
}

export function lock(): void {
  wipe(unlockedEntropy);
  unlockedEntropy = null;
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
        'protecting every client\'s buy wallet if the vault file is copied off the server.',
    );
  }
}
