import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Every secret is required in production and has no default — the process
 * refuses to start rather than fall back to a guessable value.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),

  /// Signing key for short-lived access tokens. Minimum 32 bytes of entropy.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  /// Comma-separated list of origins allowed to call the admin API.
  ADMIN_ORIGINS: z.string().default('http://localhost:5174'),

  /// When true the server refuses plaintext HTTP and emits HSTS. Terminating
  /// TLS at a proxy is fine — set TRUST_PROXY so X-Forwarded-Proto is honoured.
  REQUIRE_HTTPS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /// Optional path to the built admin dashboard (admin/dist). When set, the
  /// dashboard is served from this same process and origin — which removes
  /// the CORS configuration entirely and means one domain and one TLS
  /// certificate. Intended for single-app hosts such as cPanel.
  ADMIN_DIST_PATH: z.string().optional(),

  /// Refuse to serve mainnet (non-testnet) networks. Set this to true on a
  /// development deployment so a mistake cannot move real funds.
  TESTNET_ONLY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  adminOrigins: parsed.data.ADMIN_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

if (config.isProduction && !config.REQUIRE_HTTPS) {
  // eslint-disable-next-line no-console
  console.warn(
    '[config] REQUIRE_HTTPS is false in production. Set REQUIRE_HTTPS=true unless ' +
      'you are certain TLS is terminated in front of this process.',
  );
}
