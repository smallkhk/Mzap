import type { IpcResult } from '../../shared/types';

/**
 * An error with a stable code and a message written for a person.
 *
 * Nothing in this application surfaces a bare "Error" to the user: every
 * failure path constructs one of these, or is translated by
 * `describeRpcError` below.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toIpcError(err: unknown): IpcResult<never> {
  if (err instanceof AppError) {
    return { ok: false, error: { code: err.code, message: err.message, detail: err.detail } };
  }
  const translated = describeRpcError(err);
  return { ok: false, error: translated };
}

export const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data });

/**
 * Translates the errors ethers/JSON-RPC actually produce into sentences that
 * tell the user what happened and what to do about it.
 *
 * ethers v6 surfaces a machine-readable `code` on its errors; the node's own
 * message is kept as `detail` so a power user can still see the raw text.
 */
export function describeRpcError(err: unknown): { code: string; message: string; detail?: string } {
  const anyErr = err as
    | {
        code?: string;
        shortMessage?: string;
        message?: string;
        reason?: string;
        info?: { error?: { message?: string; code?: number } };
        error?: { message?: string };
      }
    | undefined;

  const raw =
    anyErr?.info?.error?.message ??
    anyErr?.error?.message ??
    anyErr?.shortMessage ??
    anyErr?.message ??
    String(err);

  const lower = raw.toLowerCase();
  const detail = raw.slice(0, 500);

  // --- Connectivity -------------------------------------------------------
  if (
    anyErr?.code === 'NETWORK_ERROR' ||
    anyErr?.code === 'SERVER_ERROR' ||
    anyErr?.code === 'TIMEOUT' ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed')
  ) {
    return {
      code: 'RPC_UNREACHABLE',
      message:
        'The blockchain node could not be reached. Check your internet connection, or configure ' +
        'a different RPC endpoint for this network in the admin dashboard.',
      detail,
    };
  }

  // --- Funds --------------------------------------------------------------
  if (lower.includes('insufficient funds')) {
    return {
      code: 'INSUFFICIENT_NATIVE_FOR_GAS',
      message:
        'This wallet does not hold enough of the network\'s native coin to pay the transaction ' +
        'fee. Add native coin to the sending address and try again.',
      detail,
    };
  }

  if (lower.includes('transfer amount exceeds balance')) {
    return {
      code: 'INSUFFICIENT_TOKEN_BALANCE',
      message:
        'The token contract rejected the transfer because the sending address does not hold ' +
        'that much of this token.',
      detail,
    };
  }

  if (lower.includes('transfer amount exceeds allowance')) {
    return {
      code: 'ALLOWANCE_EXCEEDED',
      message:
        'The token contract rejected the transfer on an allowance check. This application sends ' +
        'directly from the wallet that owns the tokens and does not use allowances, which ' +
        'usually means the configured contract is not a standard token.',
      detail,
    };
  }

  // --- Nonce / replay -----------------------------------------------------
  if (anyErr?.code === 'NONCE_EXPIRED' || lower.includes('nonce too low')) {
    return {
      code: 'NONCE_TOO_LOW',
      message:
        'This transaction used a nonce the network has already seen, which usually means an ' +
        'earlier transaction from this wallet confirmed first. Check your history, then retry.',
      detail,
    };
  }

  if (lower.includes('already known') || lower.includes('duplicate transaction')) {
    return {
      code: 'ALREADY_SUBMITTED',
      message:
        'This exact transaction is already in the network\'s pending pool. It has not been sent ' +
        'twice — wait for it to confirm.',
      detail,
    };
  }

  if (anyErr?.code === 'REPLACEMENT_UNDERPRICED' || lower.includes('replacement transaction underpriced')) {
    return {
      code: 'REPLACEMENT_UNDERPRICED',
      message:
        'A transaction with this nonce is already pending, and the fee offered is not high enough ' +
        'to replace it. Wait for the pending transaction to confirm.',
      detail,
    };
  }

  // --- Fees ---------------------------------------------------------------
  if (lower.includes('max fee per gas less than block base fee')) {
    return {
      code: 'FEE_TOO_LOW',
      message:
        'The network\'s base fee rose above the fee this transaction offered. Re-estimate the ' +
        'fee and send again.',
      detail,
    };
  }

  if (lower.includes('intrinsic gas too low') || lower.includes('gas limit')) {
    return {
      code: 'GAS_LIMIT_TOO_LOW',
      message: 'The gas limit was too low for this transaction to execute.',
      detail,
    };
  }

  // --- Execution ----------------------------------------------------------
  if (anyErr?.code === 'CALL_EXCEPTION' || lower.includes('execution reverted')) {
    const reason = anyErr?.reason;
    return {
      code: 'EXECUTION_REVERTED',
      message: reason
        ? `The contract rejected this transaction: ${reason}`
        : 'The contract rejected this transaction (it reverted). The token may be paused, ' +
          'may restrict transfers, or the configured contract address may not be a standard ' +
          'token contract.',
      detail,
    };
  }

  if (anyErr?.code === 'UNSUPPORTED_OPERATION' && lower.includes('network')) {
    return {
      code: 'NETWORK_MISMATCH',
      message:
        'The RPC endpoint reported a different chain than this network is configured for. ' +
        'Correct the RPC URL or chain ID in the admin dashboard before sending.',
      detail,
    };
  }

  if (lower.includes('rate limit') || lower.includes('too many requests') || anyErr?.info?.error?.code === 429) {
    return {
      code: 'RPC_RATE_LIMITED',
      message:
        'The blockchain node is rate-limiting this application. Wait a moment, or configure a ' +
        'dedicated RPC endpoint.',
      detail,
    };
  }

  return {
    code: 'UNEXPECTED_ERROR',
    message:
      'The transaction could not be completed. The node reported: ' +
      (raw.length > 200 ? `${raw.slice(0, 200)}…` : raw),
    detail,
  };
}
