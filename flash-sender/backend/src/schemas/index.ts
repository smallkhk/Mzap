import { z } from 'zod';
import {
  assertExplorerUrl,
  assertSecureRpcUrl,
  assertValidBaseUnitAmount,
  assertValidChainId,
  assertValidDecimals,
  assertValidTxHash,
  normaliseAddress,
} from '../lib/chain';

/** Wraps a throwing validator into a Zod transform that reports its message. */
const checked = <T>(fn: (value: string) => T) =>
  z.string().superRefine((value, ctx) => {
    try {
      fn(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'Invalid value.',
      });
    }
  });

export const addressSchema = checked((v) => normaliseAddress(v)).transform((v) =>
  normaliseAddress(v),
);

export const chainIdSchema = z
  .number()
  .int()
  .superRefine((value, ctx) => {
    try {
      assertValidChainId(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'Invalid chain ID.',
      });
    }
  });

export const decimalsSchema = z
  .number()
  .int()
  .superRefine((value, ctx) => {
    try {
      assertValidDecimals(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'Invalid decimals.',
      });
    }
  });

export const explorerUrlSchema = checked(assertExplorerUrl).transform(assertExplorerUrl);
export const rpcUrlSchema = checked(assertSecureRpcUrl).transform(assertSecureRpcUrl);
export const txHashSchema = checked(assertValidTxHash).transform(assertValidTxHash);
export const baseUnitAmountSchema = checked((v) => assertValidBaseUnitAmount(v));

/** Slugs used as stable public identifiers. */
export const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    'Must be lowercase letters, digits and hyphens (for example "usdt-bsc").',
  );

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email address.').toLowerCase(),
  password: z.string().min(1, 'Enter your password.'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10, 'A refresh token is required.'),
});

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

export const createNetworkSchema = z.object({
  key: slugSchema,
  name: z.string().min(1).max(80),
  chainId: chainIdSchema,
  rpcUrls: z.array(rpcUrlSchema).min(1, 'At least one RPC endpoint is required.').max(8),
  explorerUrl: explorerUrlSchema,
  nativeSymbol: z.string().min(1).max(16),
  nativeName: z.string().min(1).max(48),
  nativeDecimals: decimalsSchema.default(18),
  isTestnet: z.boolean(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const updateNetworkSchema = createNetworkSchema.partial().omit({ key: true });

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const assetBase = z.object({
  assetId: slugSchema,
  name: z.string().min(1).max(80),
  symbol: z.string().min(1).max(16),
  networkKey: slugSchema,
  isNative: z.boolean().default(false),
  contractAddress: addressSchema.nullish(),
  decimals: decimalsSchema,
  explorerUrl: explorerUrlSchema.nullish(),
  logoUrl: z.string().url().nullish(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

/**
 * A native asset must not carry a contract address, and a token asset must.
 * Enforcing this at the boundary means the desktop app can rely on the
 * invariant when choosing between a value transfer and a `transfer()` call.
 */
const assetShapeRule = <T extends { isNative: boolean; contractAddress?: string | null }>(
  value: T,
  ctx: z.RefinementCtx,
) => {
  if (value.isNative && value.contractAddress) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contractAddress'],
      message:
        'A native coin has no contract address. Clear the contract field, or untick "native".',
    });
  }
  if (value.isNative === false && !value.contractAddress) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contractAddress'],
      message: 'A token asset requires the contract address of its token contract.',
    });
  }
};

export const createAssetSchema = assetBase.superRefine(assetShapeRule);

export const updateAssetSchema = assetBase
  .partial()
  .omit({ assetId: true })
  .superRefine((value, ctx) => {
    if (value.isNative === undefined) return;
    assetShapeRule(
      { isNative: value.isNative, contractAddress: value.contractAddress },
      ctx,
    );
  });

export const assetQuerySchema = z.object({
  network: slugSchema.optional(),
  includeDisabled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const txStatusSchema = z.enum([
  'PREPARING',
  'AWAITING_CONFIRMATION',
  'SIGNING',
  'BROADCASTING',
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'REJECTED',
]);

/**
 * Recording a transaction.
 *
 * `txHash` is optional only for pre-broadcast states. Once the client reports
 * BROADCASTING or later, the hash is mandatory — the server will not accept a
 * "confirmed" record that has no on-chain identity to point at.
 */
export const createTransactionSchema = z
  .object({
    clientRef: z.string().uuid('clientRef must be a UUID generated by the client.'),
    txHash: txHashSchema.nullish(),
    chainId: chainIdSchema,
    status: txStatusSchema,
    assetId: slugSchema,
    symbol: z.string().min(1).max(16),
    decimals: decimalsSchema,
    isNative: z.boolean(),
    contractAddress: addressSchema.nullish(),
    fromAddress: addressSchema,
    toAddress: addressSchema,
    amountRaw: baseUnitAmountSchema,
    amountDisplay: z.string().min(1).max(80),
    nonce: z.number().int().nonnegative().nullish(),
    errorCode: z.string().max(64).nullish(),
    errorMessage: z.string().max(1024).nullish(),
  })
  .superRefine((value, ctx) => {
    const needsHash = ['BROADCASTING', 'PENDING', 'CONFIRMED'].includes(value.status);
    if (needsHash && !value.txHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['txHash'],
        message:
          `A transaction reported as ${value.status} must include the transaction hash ` +
          'returned by the node.',
      });
    }
  });

export const updateTransactionSchema = z
  .object({
    status: txStatusSchema,
    txHash: txHashSchema.nullish(),
    blockNumber: z.number().int().nonnegative().nullish(),
    gasUsed: z.string().regex(/^\d+$/).nullish(),
    effectiveGasPrice: z.string().regex(/^\d+$/).nullish(),
    feeRaw: z.string().regex(/^\d+$/).nullish(),
    confirmations: z.number().int().nonnegative().optional(),
    errorCode: z.string().max(64).nullish(),
    errorMessage: z.string().max(1024).nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'CONFIRMED' && !value.txHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['txHash'],
        message:
          'A transaction cannot be marked CONFIRMED without the transaction hash it was ' +
          'confirmed under.',
      });
    }
  });

export const transactionQuerySchema = z.object({
  status: txStatusSchema.optional(),
  chainId: z.coerce.number().int().positive().optional(),
  assetId: slugSchema.optional(),
  from: z.string().optional(),
  search: z.string().max(120).optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// API clients
// ---------------------------------------------------------------------------

export const createApiClientSchema = z.object({
  name: z.string().min(1).max(80),
});

// ---------------------------------------------------------------------------
// Spending limits (custodial mode)
// ---------------------------------------------------------------------------

/**
 * Limits are given in human units and converted using the asset's decimals,
 * so an administrator types "500" rather than a 20-digit base-unit integer.
 */
export const setSpendingLimitSchema = z.object({
  assetId: slugSchema,
  maxPerTx: z.string().min(1).max(80),
  maxPerDay: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
});
