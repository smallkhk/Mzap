import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { badRequest } from '../lib/errors';

type Source = 'body' | 'query' | 'params';

/**
 * Validates and *replaces* the request segment with the parsed result, so
 * handlers only ever see data that matched the schema. Unknown keys are
 * stripped by Zod's default object behaviour, which means a client cannot
 * smuggle extra fields into a Prisma call.
 */
export function validate(schema: ZodTypeAny, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      return next(badRequest('VALIDATION_FAILED', humanise(result.error), fieldErrors(result.error)));
    }

    // `req.query` has only a getter on Express 5; assign defensively.
    Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    return next();
  };
}

function fieldErrors(error: ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/** Turns the first Zod issue into a sentence a person can act on. */
function humanise(error: ZodError): string {
  const [first] = error.issues;
  if (!first) return 'The request could not be validated.';
  const field = first.path.join('.');
  return field ? `${field}: ${first.message}` : first.message;
}

/**
 * Rejects any request whose body contains something that looks like key
 * material. The backend has no legitimate use for a private key or mnemonic,
 * so receiving one means either a client bug or an attack — either way the
 * safe response is to refuse and log, without echoing the value back.
 */
const FORBIDDEN_KEYS = [
  'privatekey',
  'private_key',
  'mnemonic',
  'seedphrase',
  'seed_phrase',
  'seed',
  'keystore',
  'walletpassword',
  'wallet_password',
];

export function rejectKeyMaterial(req: Request, _res: Response, next: NextFunction) {
  const found = findForbidden(req.body, 0);
  if (found) {
    return next(
      badRequest(
        'KEY_MATERIAL_REJECTED',
        `The field "${found}" looks like wallet key material. This API never accepts private ` +
          'keys, mnemonics or keystores, and the request has been rejected without being stored.',
      ),
    );
  }
  return next();
}

function findForbidden(value: unknown, depth: number): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase().replace(/[^a-z_]/g, ''))) return key;
    const nested = findForbidden(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}
