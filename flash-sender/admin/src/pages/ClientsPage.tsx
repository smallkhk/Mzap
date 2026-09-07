import React from 'react';
import { api, ApiError, type Asset, type SpendingLimit } from '../lib/api';

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
 *
 * In custodial mode the same key also authorises sending from the server's
 * wallet, and that is what the spending limits below govern: a client with no
 * limit for an asset cannot send it at all, so granting a limit *is* granting
 * access.
 */
export function ClientsPage({ readOnly }: { readOnly: boolean }) {
  const [clients, setClients] = React.useState<Client[]>([]);
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [wallet, setWallet] = React.useState<{ custodial: boolean; address: string | null } | null>(
    null,
  );
  const [limits, setLimits] = React.useState<Record<string, SpendingLimit[]>>({});
  const [name, setName] = React.useState('');
  const [issued, setIssued] = React.useState<{ name: string; apiKey: string } | null>(null);
  const [editing, setEditing] = React.useState<Client | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const [clientBody, walletBody, assetBody] = await Promise.all([
        api.clients.list(),
        api.wallet.get(),
        api.assets.list(),
      ]);

      setClients(clientBody.clients);
      setWallet(walletBody);
      setAssets(assetBody.assets);

      // Limits only exist in custodial mode; skip the fan-out otherwise.
      if (walletBody.custodial) {
        const entries = await Promise.all(
          clientBody.clients.map(async (client) => {
            const body = await api.clients.limits(client.id);
            return [client.id, body.limits] as const;
          }),
        );
        setLimits(Object.fromEntries(entries));
      }

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

  const custodial = wallet?.custodial ?? false;

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

      {custodial && (
        <div className="card" style={{ padding: 14, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="chip chip--ok">custodial</span>
            <strong style={{ fontSize: 13 }}>This server signs for every installation</strong>
            <code className="mono">{wallet?.address}</code>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
            Installations do not hold keys. Nothing can be sent until you grant a spending limit
            per asset below — a key with no limit for an asset cannot send that asset at all.
          </p>
        </div>
      )}

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
              {custodial && <th>Allowed to send</th>}
              <th>Last seen</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => {
              const granted = limits[client.id] ?? [];
              return (
                <tr key={client.id} className={client.isActive ? '' : 'row--disabled'}>
                  <td>{client.name}</td>
                  <td className="mono">{client.keyPrefix}…</td>
                  <td>
                    <span className={`chip ${client.isActive ? 'chip--ok' : 'chip--off'}`}>
                      {client.isActive ? 'active' : 'revoked'}
                    </span>
                  </td>
                  {custodial && (
                    <td>
                      {granted.length === 0 ? (
                        <span className="chip chip--warn">nothing</span>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                          {granted.map((limit) => (
                            <span
                              key={limit.assetId}
                              className={`chip ${limit.enabled ? '' : 'chip--off'}`}
                              title={`${limit.maxPerTx} per transaction, ${limit.maxPerDay} per day`}
                            >
                              {limit.assetId}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="faint">
                    {client.lastSeenAt ? new Date(client.lastSeenAt).toLocaleString() : 'never'}
                  </td>
                  <td className="faint">{new Date(client.createdAt).toLocaleDateString()}</td>
                  <td className="actions">
                    {custodial && client.isActive && (
                      <button className="btn btn--sm" onClick={() => setEditing(client)}>
                        Spending limits
                      </button>
                    )}
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
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <LimitsModal
          client={editing}
          assets={assets}
          limits={limits[editing.id] ?? []}
          readOnly={readOnly}
          onClose={() => setEditing(null)}
          onChanged={load}
        />
      )}

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

/**
 * Grants, edits and revokes one installation's per-asset caps.
 *
 * Amounts are entered in human units (the same units the sender types); the
 * backend converts them using the asset's decimals, so nothing here has to
 * know about base units.
 */
function LimitsModal({
  client,
  assets,
  limits,
  readOnly,
  onClose,
  onChanged,
}: {
  client: Client;
  assets: Asset[];
  limits: SpendingLimit[];
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [assetId, setAssetId] = React.useState(assets[0]?.id ?? '');
  const [maxPerTx, setMaxPerTx] = React.useState('');
  const [maxPerDay, setMaxPerDay] = React.useState('');
  const [enabled, setEnabled] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const asset = assets.find((a) => a.id === assetId);

  /** Loads an existing row into the form so "edit" and "grant" are one path. */
  const edit = (limit: SpendingLimit) => {
    setAssetId(limit.assetId);
    setMaxPerTx(limit.maxPerTx);
    setMaxPerDay(limit.maxPerDay);
    setEnabled(limit.enabled);
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.clients.setLimit(client.id, { assetId, maxPerTx, maxPerDay, enabled });
      await onChanged();
      setMaxPerTx('');
      setMaxPerDay('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the limit.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (limit: SpendingLimit) => {
    if (!confirm(`Stop ${client.name} from sending ${limit.assetId}?`)) return;
    setBusy(true);
    try {
      await api.clients.revokeLimit(client.id, limit.assetId);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to revoke the limit.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop">
      <div className="modal" style={{ maxWidth: 620 }}>
        <header className="modal__head">
          <h3>Spending limits — {client.name}</h3>
        </header>

        <div className="modal__body">
          {error && <div className="alert alert--danger">{error}</div>}

          {limits.length === 0 ? (
            <div className="alert alert--warn">
              This installation cannot send anything yet. Grant it an asset below.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Per transaction</th>
                  <th>Per day</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {limits.map((limit) => (
                  <tr key={limit.assetId} className={limit.enabled ? '' : 'row--disabled'}>
                    <td className="mono">{limit.assetId}</td>
                    <td>{limit.maxPerTx}</td>
                    <td>{limit.maxPerDay}</td>
                    <td>
                      <span className={`chip ${limit.enabled ? 'chip--ok' : 'chip--off'}`}>
                        {limit.enabled ? 'enabled' : 'paused'}
                      </span>
                    </td>
                    <td className="actions">
                      {!readOnly && (
                        <>
                          <button className="btn btn--sm" onClick={() => edit(limit)}>
                            Edit
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            disabled={busy}
                            onClick={() => void revoke(limit)}
                          >
                            Revoke
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!readOnly && (
            <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
              <label className="field">
                <span>Asset</span>
                <select
                  className="input"
                  value={assetId}
                  required
                  onChange={(e) => setAssetId(e.target.value)}
                >
                  <option value="" disabled>
                    Choose an asset…
                  </option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.symbol} — {a.name} ({a.network.name})
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid-2">
                <label className="field">
                  <span>Max per transaction</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    placeholder="0.05"
                    required
                    value={maxPerTx}
                    onChange={(e) => setMaxPerTx(e.target.value)}
                  />
                  <small className="faint">In {asset?.symbol ?? 'the asset'}, not base units.</small>
                </label>

                <label className="field">
                  <span>Max per day</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    placeholder="0.2"
                    required
                    value={maxPerDay}
                    onChange={(e) => setMaxPerDay(e.target.value)}
                  />
                  <small className="faint">Rolling 24 hours, across all sends.</small>
                </label>
              </div>

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>
                  Enabled. Unticking pauses sending for this asset without losing the amounts.
                </span>
              </label>

              <button className="btn btn--primary" type="submit" disabled={busy || !assetId}>
                {busy ? 'Saving…' : 'Save limit'}
              </button>
            </form>
          )}
        </div>

        <footer className="modal__foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
