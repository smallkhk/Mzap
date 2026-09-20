import React from 'react';
import { api, ApiError, type Asset, type SpendingLimit } from '../lib/api';

/**
 * This installation's own spending limits.
 *
 * There is no client picker here — unlike the admin dashboard's equivalent
 * screen, this one has nothing to pick: every call acts on whichever key
 * signed in, because that is the only client this API surface can ever see.
 */
export function LimitsPage() {
  const [limits, setLimits] = React.useState<SpendingLimit[]>([]);
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState<SpendingLimit | 'new' | null>(null);

  const load = React.useCallback(async () => {
    try {
      const [limitsBody, assetsBody] = await Promise.all([api.limits.list(), api.assets.list()]);
      setLimits(limitsBody.limits);
      setAssets(assetsBody.assets);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load your limits.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const assetsById = React.useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const grantedIds = React.useMemo(() => new Set(limits.map((l) => l.assetId)), [limits]);
  const ungranted = assets.filter((a) => !grantedIds.has(a.id));

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>My sending limits</h2>
          <p className="muted">
            You can only send an asset once it has a limit here — granting one is what turns
            sending on for that token.
          </p>
        </div>
        {!loading && ungranted.length > 0 && (
          <button className="btn btn--primary" onClick={() => setEditing('new')}>
            + Grant a limit
          </button>
        )}
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      {!loading && limits.length === 0 && (
        <div className="alert alert--warn">
          You have no spending limits yet, so this key cannot send anything. Grant one for a token
          below to start.
        </div>
      )}

      {limits.length > 0 && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Network</th>
                <th>Per transaction</th>
                <th>Per day</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {limits.map((limit) => {
                const asset = assetsById.get(limit.assetId);
                return (
                  <tr key={limit.assetId} className={limit.enabled ? '' : 'row--disabled'}>
                    <td>
                      <strong>{asset?.symbol ?? limit.assetId}</strong>{' '}
                      <span className="faint mono">{limit.assetId}</span>
                    </td>
                    <td className="faint">{asset?.network.name ?? '—'}</td>
                    <td>{limit.maxPerTx}</td>
                    <td>{limit.maxPerDay}</td>
                    <td>
                      <span className={`chip ${limit.enabled ? 'chip--ok' : 'chip--off'}`}>
                        {limit.enabled ? 'enabled' : 'paused'}
                      </span>
                    </td>
                    <td className="actions">
                      <button className="btn btn--sm" onClick={() => setEditing(limit)}>
                        Edit
                      </button>
                      <button
                        className="btn btn--sm btn--danger"
                        onClick={async () => {
                          if (!confirm(`Stop sending ${asset?.symbol ?? limit.assetId}?`)) return;
                          try {
                            await api.limits.revoke(limit.assetId);
                            await load();
                          } catch (err) {
                            setError(err instanceof ApiError ? err.message : 'Failed to revoke.');
                          }
                        }}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <LimitEditor
          limit={editing === 'new' ? null : editing}
          assets={editing === 'new' ? ungranted : assets}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function LimitEditor({
  limit,
  assets,
  onClose,
  onSaved,
}: {
  limit: SpendingLimit | null;
  assets: Asset[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [assetId, setAssetId] = React.useState(limit?.assetId ?? assets[0]?.id ?? '');
  const [maxPerTx, setMaxPerTx] = React.useState(limit?.maxPerTx ?? '');
  const [maxPerDay, setMaxPerDay] = React.useState(limit?.maxPerDay ?? '');
  const [enabled, setEnabled] = React.useState(limit?.enabled ?? true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const asset = assets.find((a) => a.id === assetId);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.limits.set({ assetId, maxPerTx, maxPerDay, enabled });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop">
      <div className="modal" style={{ maxWidth: 480 }}>
        <header className="modal__head">
          <h3>{limit ? `Edit limit — ${limit.assetId}` : 'Grant a spending limit'}</h3>
        </header>

        <form className="modal__body" onSubmit={submit}>
          {error && <div className="alert alert--danger">{error}</div>}

          {!limit && (
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
          )}

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
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Enabled. Unticking pauses sending without losing the amounts.</span>
          </label>

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" type="submit" disabled={busy || !assetId} style={{ flex: 1 }}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
