import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TransactionRecord, TxState } from '../../shared/types';

/**
 * Local transaction history.
 *
 * The local store is the user's own copy and survives the backend being
 * unreachable. Records are written at every state change, so a transaction
 * that was broadcast is never lost even if the app is killed mid-flight —
 * on next launch the watcher resumes from the stored hash.
 *
 * A JSON file (rather than SQLite) keeps the application free of native
 * modules, which keeps `electron-builder` cross-compiling cleanly and avoids
 * rebuild-per-Electron-version friction. Volumes here are small: this is one
 * operator's send history.
 */

const HISTORY_FILE = 'history.json';
const MAX_RECORDS = 5_000;

let cache: TransactionRecord[] | null = null;
let writeChain: Promise<void> = Promise.resolve();

const historyPath = () => path.join(app.getPath('userData'), HISTORY_FILE);

async function load(): Promise<TransactionRecord[]> {
  if (cache) return cache;

  try {
    const raw = await fs.readFile(historyPath(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? (parsed as TransactionRecord[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** Serialised through a promise chain so concurrent updates cannot interleave. */
function persist(): Promise<void> {
  writeChain = writeChain.then(async () => {
    const target = historyPath();
    const data = JSON.stringify(cache ?? [], null, 2);
    await fs.writeFile(`${target}.tmp`, data, { mode: 0o600 });
    await fs.rename(`${target}.tmp`, target);
  });
  return writeChain;
}

export async function listTransactions(): Promise<TransactionRecord[]> {
  const records = await load();
  return [...records].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

export async function getTransaction(clientRef: string): Promise<TransactionRecord | null> {
  const records = await load();
  return records.find((r) => r.clientRef === clientRef) ?? null;
}

export async function upsertTransaction(record: TransactionRecord): Promise<TransactionRecord> {
  const records = await load();
  const index = records.findIndex((r) => r.clientRef === record.clientRef);

  if (index === -1) records.unshift(record);
  else records[index] = record;

  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;

  await persist();
  return record;
}

export async function patchTransaction(
  clientRef: string,
  patch: Partial<TransactionRecord>,
): Promise<TransactionRecord | null> {
  const records = await load();
  const index = records.findIndex((r) => r.clientRef === clientRef);
  if (index === -1) return null;

  const updated = { ...records[index]!, ...patch };
  records[index] = updated;

  await persist();
  return updated;
}

/**
 * Records still in flight when the app last closed. Used at startup to resume
 * watching so a transaction never sits at "Pending" forever just because the
 * app restarted.
 */
export async function findUnsettled(): Promise<TransactionRecord[]> {
  const unsettled: TxState[] = ['BROADCASTING', 'PENDING'];
  const records = await load();
  return records.filter((r) => unsettled.includes(r.status) && r.txHash);
}

export async function clearHistory(): Promise<void> {
  cache = [];
  await persist();
}
