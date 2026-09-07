import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { config } from '../config';

/**
 * Normalises the client IP for use as a limiter key.
 *
 * IPv6 clients are bucketed by their /64 prefix rather than the full address:
 * a single subscriber is typically handed a whole /64, so keying on the exact
 * address would let one attacker trivially sidestep the limit by rotating
 * within their own allocation.
 */
function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';

  if (ip.includes(':')) {
    const groups = ip.split(':');
    return groups.slice(0, 4).join(':') + '::/64';
  }
  return ip;
}

const message = (retryAfterHint: string) => ({
  error: {
    code: 'RATE_LIMITED',
    message: `Too many requests. ${retryAfterHint}`,
  },
});

/** General API limiter, keyed by API client when present, else by IP. */
export const apiLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.client?.id ?? clientIp(req),
  message: message('Please wait a moment before trying again.'),
  skip: () => config.isTest,
});

/**
 * Strict limiter for credential endpoints. Keyed by IP *and* submitted email
 * so one attacker cannot lock out every account from a single address, and a
 * distributed attack still hits the per-account ceiling.
 */
export const authLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'anon';
    return `${clientIp(req)}:${email}`;
  },
  message: message('Too many sign-in attempts. Wait a minute before trying again.'),
  skip: () => config.isTest,
});

/**
 * Transaction recording is limited more tightly than plain reads: a runaway
 * client should not be able to flood the ledger.
 */
export const writeLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: Math.max(10, Math.floor(config.RATE_LIMIT_MAX / 4)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.client?.id ?? req.admin?.id ?? clientIp(req),
  message: message('Please wait a moment before submitting again.'),
  skip: () => config.isTest,
});
