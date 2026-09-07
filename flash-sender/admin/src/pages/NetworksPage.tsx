import React from 'react';
import { api, ApiError, type Network } from '../lib/api';

export function NetworksPage({ readOnly, onChanged }: { readOnly: boolean; onChanged: () => void }) {
  const [networks, setNetworks] = React.useState<Network[]>([]);
  const [editing, setEditing] = React.useState<Network | 'new' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setNetworks((await api.networks.list()).networks);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load networks.');
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>Networks</h2>
          <p className="muted">
            Chains the application can connect to. The chain ID is verified against the RPC endpoint
            before any transaction is signed.
          </p>
        </div>
        {!readOnly && (
          <button className="btn btn--primary" onClick={() => setEditing('new')}>
            + Add network
          </button>
        )}
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Chain ID</th>
              <th>Native</th>
              <th>RPC endpoints</th>
              <th>Type</th>
              <th>Assets</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {networks.map((network) => (
              <tr key={network.key} className={network.enabled ? '' : 'row--disabled'}>
                <td>
                  <strong>{network.name}</strong>
                </td>
                <td className="mono">{network.key}</td>
                <td className="mono">{network.chainId}</td>
                <td className="mono">
                  {network.nativeSymbol}
                  <span className="faint"> ({network.nativeDecimals})</span>
                </td>
                <td className="mono faint">{network.rpcUrls.length} configured</td>
                <td>
                  <span className={`chip ${network.isTestnet ? '' : 'chip--danger'}`}>
                    {network.isTestnet ? 'testnet' : 'MAINNET'}
                  </span>
                </td>
                <td className="mono">{network.assetCount ?? 0}</td>
                <td className="actions">
                  {!readOnly && (
                    <>
                      <button className="btn btn--sm" onClick={() => setEditing(network)}>
                        Edit
                      </button>
                      <button
                        className="btn btn--sm btn--danger"
                        disabled={Boolean(network.assetCount)}
                        title={
                          network.assetCount
                            ? 'Remove its assets first'
                            : 'Delete this network'
                        }
                        onClick={async () => {
                          if (!confirm(`Delete ${network.name}?`)) return;
                          try {
                            await api.networks.remove(network.key);
                            await load();
                            onChanged();
                          } catch (err) {
                            setError(err instanceof ApiError ? err.message : 'Delete failed.');
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <NetworkEditor
          network={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function NetworkEditor({
  network,
  onClose,
  onSaved,
}: {
  network: Network | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState({
    key: network?.key ?? '',
    name: network?.name ?? '',
    chainId: network?.chainId ?? 0,
    rpcUrls: (network?.rpcUrls ?? []).join('\n'),
    explorerUrl: network?.explorerUrl ?? '',
    nativeSymbol: network?.nativeSymbol ?? '',
    nativeName: network?.nativeName ?? '',
    nativeDecimals: network?.nativeDecimals ?? 18,
    isTestnet: network?.isTestnet ?? true,
    enabled: network?.enabled ?? true,
    sortOrder: network?.sortOrder ?? 0,
  });

  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const payload = {
      name: form.name,
      chainId: Number(form.chainId),
      rpcUrls: form.rpcUrls
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      explorerUrl: form.explorerUrl.trim(),
      nativeSymbol: form.nativeSymbol,
      nativeName: form.nativeName || form.nativeSymbol,
      nativeDecimals: Number(form.nativeDecimals),
      isTestnet: form.isTestnet,
      enabled: form.enabled,
      sortOrder: Number(form.sortOrder),
    };

    try {
      if (network) await api.networks.update(network.key, payload);
      else await api.networks.create({ ...payload, key: form.key } as Partial<Network>);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <header className="modal__head">
          <h3>{network ? `Edit ${network.name}` : 'Add network'}</h3>
        </header>

        <div className="modal__body">
          {!network && (
            <label className="field">
              <span>Key</span>
              <input
                className="input mono"
                required
                placeholder="bsc"
                value={form.key}
                onChange={(e) => set('key', e.target.value)}
              />
            </label>
          )}

          <div className="grid-2">
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                required
                placeholder="BNB Smart Chain"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </label>

            <label className="field">
              <span>Chain ID</span>
              <input
                className="input mono"
                type="number"
                min={1}
                required
                placeholder="56"
                value={form.chainId || ''}
                onChange={(e) => set('chainId', Number(e.target.value))}
              />
            </label>
          </div>

          <label className="field">
            <span>RPC endpoints</span>
            <textarea
              className="input mono"
              rows={3}
              required
              placeholder={'https://bsc-dataseed.bnbchain.org\nhttps://…'}
              value={form.rpcUrls}
              onChange={(e) => set('rpcUrls', e.target.value)}
            />
            <small className="faint">
              One per line, tried in order. Must be https or wss — plaintext RPC is rejected.
            </small>
          </label>

          <label className="field">
            <span>Block explorer</span>
            <input
              className="input mono"
              required
              placeholder="https://bscscan.com"
              value={form.explorerUrl}
              onChange={(e) => set('explorerUrl', e.target.value)}
            />
          </label>

          <div className="grid-3">
            <label className="field">
              <span>Native symbol</span>
              <input
                className="input"
                required
                placeholder="BNB"
                value={form.nativeSymbol}
                onChange={(e) => set('nativeSymbol', e.target.value)}
              />
            </label>

            <label className="field">
              <span>Native name</span>
              <input
                className="input"
                placeholder="BNB"
                value={form.nativeName}
                onChange={(e) => set('nativeName', e.target.value)}
              />
            </label>

            <label className="field">
              <span>Native decimals</span>
              <input
                className="input mono"
                type="number"
                min={0}
                max={36}
                value={form.nativeDecimals}
                onChange={(e) => set('nativeDecimals', Number(e.target.value))}
              />
            </label>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.isTestnet}
              onChange={(e) => set('isTestnet', e.target.checked)}
            />
            <span>This is a testnet (no real funds)</span>
          </label>

          {!form.isTestnet && (
            <div className="alert alert--danger">
              Marking this as a mainnet means assets on it move real, irreversible funds. Desktop
              clients additionally require mainnet to be enabled in their own settings.
            </div>
          )}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            <span>Enabled</span>
          </label>

          {error && <div className="alert alert--danger">{error}</div>}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  );
}
