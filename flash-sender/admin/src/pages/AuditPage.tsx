import React from 'react';
import { api, ApiError, type AuditEntry } from '../lib/api';

/** Read-only view of the append-only audit log. */
export function AuditPage() {
  const [logs, setLogs] = React.useState<AuditEntry[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState('');

  React.useEffect(() => {
    void (async () => {
      try {
        setLogs((await api.audit.list()).logs);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load the audit log.');
      }
    })();
  }, []);

  const visible = logs.filter((log) =>
    filter ? `${log.action} ${log.actorLabel ?? ''} ${log.entity ?? ''}`.includes(filter) : true,
  );

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>Audit log</h2>
          <p className="muted">
            Every configuration change and authentication event. Append-only.
          </p>
        </div>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="Filter by action or actor…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Entity</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((log) => (
              <tr key={log.id}>
                <td className="faint">{new Date(log.createdAt).toLocaleString()}</td>
                <td className="mono">{log.action}</td>
                <td>
                  {log.actorLabel ?? <span className="faint">—</span>}
                  <span className="chip">{log.actorType}</span>
                </td>
                <td className="faint">
                  {log.entity ? `${log.entity} ${log.entityId?.slice(0, 8) ?? ''}` : '—'}
                </td>
                <td className="mono faint">{log.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!visible.length && (
          <p className="muted" style={{ padding: 32, textAlign: 'center' }}>
            No entries.
          </p>
        )}
      </div>
    </div>
  );
}
