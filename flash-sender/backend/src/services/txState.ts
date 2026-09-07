/**
 * Legal transitions for a transaction record.
 *
 * Declared with plain string literals rather than the generated Prisma enum so
 * this module (and its tests) stay runtime-independent of the database client.
 * The union is structurally identical to `TxStatus` in schema.prisma.
 *
 * CONFIRMED, FAILED and REJECTED are terminal. Once a chain has told us what
 * happened, that verdict is not editable — which is what stops a buggy or
 * malicious client from relabelling a failed transfer as successful.
 */
export type TxState =
  | 'PREPARING'
  | 'AWAITING_CONFIRMATION'
  | 'SIGNING'
  | 'BROADCASTING'
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REJECTED';

const TRANSITIONS: Record<TxState, TxState[]> = {
  PREPARING: ['AWAITING_CONFIRMATION', 'REJECTED', 'FAILED'],
  AWAITING_CONFIRMATION: ['SIGNING', 'REJECTED', 'FAILED'],
  SIGNING: ['BROADCASTING', 'REJECTED', 'FAILED'],
  // A very fast chain can produce a receipt before the client polls, so
  // BROADCASTING may settle directly.
  BROADCASTING: ['PENDING', 'FAILED', 'CONFIRMED'],
  PENDING: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
  REJECTED: [],
};

export const TERMINAL_STATES: TxState[] = ['CONFIRMED', 'FAILED', 'REJECTED'];

export const isTerminal = (status: TxState) => TERMINAL_STATES.includes(status);

export function canTransition(from: TxState, to: TxState): boolean {
  if (from === to) return true; // idempotent re-report of the same state
  return TRANSITIONS[from].includes(to);
}

export function describeIllegalTransition(from: TxState, to: TxState): string {
  if (isTerminal(from)) {
    return (
      `This transaction is already recorded as ${from}, which is final. A settled ` +
      `transaction cannot be changed to ${to}.`
    );
  }
  return `A transaction cannot move directly from ${from} to ${to}.`;
}
