import React from 'react';
import { api, ApiError } from '../lib/api';

interface Client {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

/**
 * API keys for desktop installations.
 *
 * A key grants read access to configuration and the ability to record that
 * installation's own transactions — nothing else. It can never modify an
 * asset or a contract address.
 */
export function ClientsPage({ readOnly }: { readOnly: boolean }) {
  const [clients, setClients] = React.useState<Client[]>([]);
  const [name, setName] = React.useState('');
  const [issued, setIssued] = React.useState<{ name: string; apiKey: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setClients((await api.clients.list()).clients);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load clients.');
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const body = await api.clients.create(name);
      setIssued({ name: body.client.name, apiKey: body.apiKey });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create the key.');
    }
  };

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>Application keys</h2>
          <p className="muted">
            One key per desktop installation. Paste it into the app under Settings → Backend.
          </p>
        </div>
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      {!readOnly && (
        <form className="card inline-form" onSubmit={create}>
          <input
            className="input"
            placeholder="Installation name, e.g. Nora's workstation"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn--primary" type="submit">
            Issue key
          </button>
        </form>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key prefix</th>
              <th>Status</th>
              <th>Last seen</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.id} className={client.isActive ? '' : 'row--disabled'}>
                <td>{client.name}</td>
                <td className="mono">{client.keyPrefix}…</td>
                <td>
                  <span className={`chip ${client.isActive ? 'chip--ok' : 'chip--off'}`}>
                    {client.isActive ? 'active' : 'revoked'}
                  </span>
                </td>
                <td className="faint">
                  {client.lastSeenAt ? new Date(client.lastSeenAt).toLocaleString() : 'never'}
                </td>
                <td className="faint">{new Date(client.createdAt).toLocaleDateString()}</td>
                <td className="actions">
                  {!readOnly && client.isActive && (
                    <button
                      className="btn btn--sm btn--danger"
                      onClick={async () => {
                        if (!confirm(`Revoke the key for ${client.name}?`)) return;
                        await api.clients.revoke(client.id);
                        await load();
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {issued && (
        <div className="backdrop">
          <div className="modal">
            <header className="modal__head">
              <h3>API key for {issued.name}</h3>
            </header>
            <div className="modal__body">
              <div className="alert alert--warn">
                Copy this now. Only a hash is stored, so it cannot be shown again.
              </div>
              <code className="key-box">{issued.apiKey}</code>
              <button
                className="btn"
                onClick={() => void navigator.clipboard.writeText(issued.apiKey)}
              >
                Copy to clipboard
              </button>
            </div>
            <footer className="modal__foot">
              <button className="btn btn--primary" onClick={() => setIssued(null)}>
                Done
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
