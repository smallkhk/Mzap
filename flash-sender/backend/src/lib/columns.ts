/**
 * Column encoders for values that have no native MySQL column type.
 *
 * PostgreSQL has array and JSONB columns; MySQL/MariaDB does not have arrays,
 * and MariaDB's JSON is an alias for LONGTEXT rather than a real type. Rather
 * than depend on that, these values are stored as TEXT and encoded here, so
 * the same schema runs on MySQL 8 and MariaDB 10.x alike — which matters
 * because shared hosts differ on which one they provide.
 *
 * Everything crossing the API boundary keeps its natural shape: the wire
 * format is unchanged, and only the storage representation differs.
 */

/**
 * RPC endpoint lists are stored newline-delimited.
 *
 * Newline is safe as a separator because a URL cannot contain a raw newline —
 * and every URL is validated by `assertSecureRpcUrl` before it reaches here,
 * so nothing malformed can be stored in the first place.
 */
export function encodeUrlList(urls: string[]): string {
  return urls.map((url) => url.trim()).filter(Boolean).join('\n');
}

export function decodeUrlList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((url) => url.trim())
    .filter(Boolean);
}

/**
 * Audit snapshots are stored as JSON text.
 *
 * Serialisation is defensive: an audit write must never throw and break the
 * request it is describing, so a value that cannot be serialised (a cycle, a
 * BigInt) is recorded as a note rather than propagating the error.
 */
export function encodeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item,
    );
  } catch {
    return JSON.stringify({ note: 'Value could not be serialised for the audit log.' });
  }
}

export function decodeJson<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
