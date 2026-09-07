import type { TxState } from '../../shared/types';

/** Truncates an address for dense display, keeping enough to eyeball a match. */
export function shortAddress(address: string | null, lead = 6, tail = 4): string {
  if (!address) return '—';
  if (address.length <= lead + tail + 2) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function shortHash(hash: string | null): string {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : '—';
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

interface StateDescriptor {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  /** What is actually happening, in plain words. */
  description: string;
  /** Whether the state is still moving. */
  active: boolean;
}

/**
 * The vocabulary the UI uses for transaction state.
 *
 * Note that "Confirmed" is the only state that claims success, and it is only
 * ever set from a receipt with `status === 1`. "Failed" explicitly explains
 * that the transaction reached the chain but did not transfer anything, since
 * that distinction is the one users most need and most often miss.
 */
export const TX_STATES: Record<TxState, StateDescriptor> = {
  PREPARING: {
    label: 'Preparing',
    tone: 'neutral',
    description: 'Checking balances, verifying the contract and estimating the network fee.',
    active: true,
  },
  AWAITING_CONFIRMATION: {
    label: 'Awaiting confirmation',
    tone: 'info',
    description: 'Waiting for you to review and approve the details. Nothing has been signed.',
    active: true,
  },
  SIGNING: {
    label: 'Signing',
    tone: 'info',
    description: 'Signing the transaction locally with your wallet key.',
    active: true,
  },
  BROADCASTING: {
    label: 'Broadcasting',
    tone: 'info',
    description: 'Sending the signed transaction to the network.',
    active: true,
  },
  PENDING: {
    label: 'Pending',
    tone: 'warning',
    description: 'The network has accepted the transaction and it is waiting to be mined.',
    active: true,
  },
  CONFIRMED: {
    label: 'Confirmed',
    tone: 'success',
    description: 'Included in a block and executed successfully. The transfer is complete.',
    active: false,
  },
  FAILED: {
    label: 'Failed',
    tone: 'danger',
    description: 'The transaction did not complete. No funds were transferred.',
    active: false,
  },
  REJECTED: {
    label: 'Rejected',
    tone: 'neutral',
    description: 'Cancelled before signing. Nothing was sent and no fee was paid.',
    active: false,
  },
};
