import { describe, expect, it } from 'vitest';
import { canTransition, describeIllegalTransition, isTerminal } from '../src/services/txState';

/**
 * These rules are the backstop for the product's central honesty guarantee:
 * a record cannot become CONFIRMED except by way of an actual broadcast, and
 * once settled it cannot be rewritten.
 */
describe('transaction state machine', () => {
  it('walks the full happy path', () => {
    const path = [
      'PREPARING',
      'AWAITING_CONFIRMATION',
      'SIGNING',
      'BROADCASTING',
      'PENDING',
      'CONFIRMED',
    ] as const;

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('never allows a jump straight to CONFIRMED from a pre-broadcast state', () => {
    expect(canTransition('PREPARING', 'CONFIRMED')).toBe(false);
    expect(canTransition('AWAITING_CONFIRMATION', 'CONFIRMED')).toBe(false);
    expect(canTransition('SIGNING', 'CONFIRMED')).toBe(false);
  });

  it('treats CONFIRMED, FAILED and REJECTED as terminal', () => {
    for (const terminal of ['CONFIRMED', 'FAILED', 'REJECTED'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      expect(canTransition(terminal, 'PENDING')).toBe(false);
      expect(canTransition(terminal, 'CONFIRMED')).toBe(terminal === 'CONFIRMED');
    }
  });

  it('cannot relabel a failed transaction as confirmed', () => {
    expect(canTransition('FAILED', 'CONFIRMED')).toBe(false);
    expect(describeIllegalTransition('FAILED', 'CONFIRMED')).toMatch(/final/);
  });

  it('is idempotent for a repeated report of the same state', () => {
    expect(canTransition('PENDING', 'PENDING')).toBe(true);
    expect(canTransition('CONFIRMED', 'CONFIRMED')).toBe(true);
  });

  it('allows a user rejection before broadcast but not after', () => {
    expect(canTransition('AWAITING_CONFIRMATION', 'REJECTED')).toBe(true);
    expect(canTransition('SIGNING', 'REJECTED')).toBe(true);
    expect(canTransition('PENDING', 'REJECTED')).toBe(false);
  });

  it('explains an illegal transition in a sentence', () => {
    expect(describeIllegalTransition('PREPARING', 'PENDING')).toBe(
      'A transaction cannot move directly from PREPARING to PENDING.',
    );
  });
});
