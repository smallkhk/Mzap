import argon2 from 'argon2';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { AdminRole } from '@prisma/client';

/**
 * Password hashing uses Argon2id with parameters at the high end of the
 * OWASP recommendation. Password *verification* is intentionally slow.
 */
const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (plain: string) => argon2.hash(plain, ARGON_OPTIONS);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: AdminRole;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  // `expiresIn` is typed as a template-literal union ("15m", "1h", …); the
  // value comes from configuration as a plain string, so the cast is on the
  // options object rather than on the claims.
  const options = {
    expiresIn: config.ACCESS_TOKEN_TTL,
    issuer: 'flash-sender-backend',
    audience: 'flash-sender-admin',
  } as jwt.SignOptions;

  return jwt.sign(claims, config.JWT_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  return jwt.verify(token, config.JWT_SECRET, {
    issuer: 'flash-sender-backend',
    audience: 'flash-sender-admin',
  }) as AccessTokenClaims;
}

/** Opaque, high-entropy refresh token. Only its hash is persisted. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: sha256(token) };
}

/**
 * API keys are shown once, then stored as a SHA-256 digest. SHA-256 (rather
 * than Argon2) is appropriate here because the key is 256 bits of random
 * data — there is nothing to brute-force — and it must be verifiable on
 * every request without a 20ms delay.
 */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  const key = `fsk_${raw}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 12) };
}

export const sha256 = (value: string) =>
  crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/** Constant-time comparison for equal-length digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
