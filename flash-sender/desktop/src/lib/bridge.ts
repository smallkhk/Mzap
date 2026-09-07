import type { FlashSenderApi } from '../../electron/preload';
import type { IpcResult } from '../../shared/types';

declare global {
  interface Window {
    flashSender: FlashSenderApi;
  }
}

export const bridge = window.flashSender;

/** Error shape the UI renders. Always has a human-readable `message`. */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/**
 * Unwraps an IPC envelope, throwing a `BridgeError` on failure.
 *
 * Use this when a failure should interrupt the flow. For places where the UI
 * would rather show an inline message, use `attempt` below.
 */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (result.ok) return result.data;
  throw new BridgeError(result.error.code, result.error.message, result.error.detail);
}

/** Non-throwing variant: returns either the value or the error to display. */
export async function attempt<T>(
  promise: Promise<IpcResult<T>>,
): Promise<{ data: T; error: null } | { data: null; error: BridgeError }> {
  const result = await promise;
  if (result.ok) return { data: result.data, error: null };
  return {
    data: null,
    error: new BridgeError(result.error.code, result.error.message, result.error.detail),
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof BridgeError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
