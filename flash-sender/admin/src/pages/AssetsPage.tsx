import React from 'react';
import { api, ApiError, type Asset, type Network } from '../lib/api';

/**
 * Asset management.
 *
 * This is the screen that makes a new token sendable. Saving here bumps the
 * backend's configuration version; every desktop client notices on its next
 * poll and picks the token up — no rebuild, no reinstall, no client-side
 * hard-coded contract addresses anywhere.
 */
export function AssetsPage({ readOnly, onChanged }: { readOnly: boolean; onChanged: () => void }) {
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [networks, setNetworks] = React.useState<Network[]>([]);
  const [editing, setEditing] = React.useState<Asset | 'new' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const [assetsBody, networksBody] = await Promise.all([
        api.assets.list(),
        api.networks.list(),
      ]);
      setAssets(assetsBody.assets);
      setNetworks(networksBody.networks);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load assets.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      onChanged();
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The action failed.');
    }
  };

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>Assets</h2>
          <p className="muted">
            Coins and tokens the desktop application may send. Changes reach clients automatically.
          </p>
        </div>
        {!readOnly && (
          <button className="btn btn--primary" onClick={() => setEditing('new')}>
            + Add asset
          </button>
        )}
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      {loading ? (
        <div className="card muted" style={{ padding: 32, textAlign: 'center' }}>
          Loading…
        </div>
      ) : !assets.length ? (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <p className="muted">
            No assets configured yet. Add a network first, then add the coin or token you want to
            send.
          </p>
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Name</th>
                <th>Network</th>
                <th>Chain</th>
                <th>Contract</th>
                <th>Decimals</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.id} className={asset.enabled ? '' : 'row--disabled'}>
                  <td>
                    <strong>{asset.symbol}</strong>
                    <div className="mono faint">{asset.id}</div>
                  </td>
                  <td>{asset.name}</td>
                  <td>
                    {asset.network.name}
                    <span className={`chip ${asset.network.isTestnet ? '' : 'chip--danger'}`}>
                      {asset.network.isTestnet ? 'testnet' : 'MAINNET'}
                    </span>
                  </td>
                  <td className="mono">{asset.chainId}</td>
                  <td className="mono">
                    {asset.isNative ? (
                      <span className="faint">native coin</span>
                    ) : (
                      <span title={asset.contractAddress ?? ''}>
                        {asset.contractAddress?.slice(0, 10)}…{asset.contractAddress?.slice(-6)}
                      </span>
                    )}
                  </td>
                  <td className="mono">{asset.decimals}</td>
                  <td>
                    <span className={`chip ${asset.enabled ? 'chip--ok' : 'chip--off'}`}>
                      {asset.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </td>
                  <td className="actions">
                    {!readOnly && (
                      <>
                        <button className="btn btn--sm" onClick={() => setEditing(asset)}>
                          Edit
                        </button>
                        <button
                          className="btn btn--sm"
                          onClick={() => act(() => api.assets.toggle(asset.id))}
                        >
                          {asset.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          className="btn btn--sm btn--danger"
                          onClick={() => {
                            if (
                              confirm(
                                `Delete ${asset.symbol}? Desktop clients will stop offering it. ` +
                                  'Disabling is usually safer.',
                              )
                            ) {
                              void act(() => api.assets.remove(asset.id));
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
      )}

      {editing && (
        <AssetEditor
          asset={editing === 'new' ? null : editing}
          networks={networks}
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

function AssetEditor({
  asset,
  networks,
  onClose,
  onSaved,
}: {
  asset: Asset | null;
  networks: Network[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState({
    assetId: asset?.id ?? '',
    name: asset?.name ?? '',
    symbol: asset?.symbol ?? '',
    networkKey: asset?.network.key ?? networks[0]?.key ?? '',
    isNative: asset?.isNative ?? false,
    contractAddress: asset?.contractAddress ?? '',
    decimals: asset?.decimals ?? 18,
    explorerUrl: asset?.explorerUrl ?? '',
    enabled: asset?.enabled ?? true,
    sortOrder: asset?.sortOrder ?? 0,
  });

  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const network = networks.find((n) => n.key === form.networkKey);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const payload: Record<string, unknown> = {
      name: form.name,
      symbol: form.symbol,
      networkKey: form.networkKey,
      isNative: form.isNative,
      contractAddress: form.isNative ? null : form.contractAddress.trim(),
      decimals: Number(form.decimals),
      explorerUrl: form.explorerUrl.trim() || null,
      enabled: form.enabled,
      sortOrder: Number(form.sortOrder),
    };

    try {
      if (asset) {
        await api.assets.update(asset.id, payload);
      } else {
        await api.assets.create({ ...payload, assetId: form.assetId });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.fieldErrors) {
          setFieldErrors(
            Object.fromEntries(err.fieldErrors.map((f) => [f.field, f.message])),
          );
        }
      } else {
        setError('Save failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <header className="modal__head">
          <h3>{asset ? `Edit ${asset.symbol}` : 'Add asset'}</h3>
        </header>

        <div className="modal__body">
          {!asset && (
            <label className="field">
              <span>Asset ID</span>
              <input
                className="input mono"
                required
                placeholder="usdt-bsc"
                value={form.assetId}
                onChange={(e) => set('assetId', e.target.value)}
              />
              <small className="faint">
                Stable identifier used by the desktop app. Lowercase, hyphens. Cannot be changed
                later.
              </small>
              {fieldErrors.assetId && <small className="danger">{fieldErrors.assetId}</small>}
            </label>
          )}

          <div className="grid-2">
            <label className="field">
              <span>Symbol</span>
              <input
                className="input"
                required
                placeholder="USDT"
                value={form.symbol}
                onChange={(e) => set('symbol', e.target.value)}
              />
            </label>

            <label className="field">
              <span>Name</span>
              <input
                className="input"
                required
                placeholder="Tether USD"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>Network</span>
            <select
              className="input"
              value={form.networkKey}
              onChange={(e) => set('networkKey', e.target.value)}
            >
              {networks.map((n) => (
                <option key={n.key} value={n.key}>
                  {n.name} — chain {n.chainId} {n.isTestnet ? '(testnet)' : '(MAINNET)'}
                </option>
              ))}
            </select>
            {network && !network.isTestnet && (
              <small className="danger">
                This is a live network. Assets here move real funds.
              </small>
            )}
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.isNative}
              onChange={(e) => {
                set('isNative', e.target.checked);
                if (e.target.checked && network) set('decimals', network.nativeDecimals);
              }}
            />
            <span>
              This is the network&apos;s native coin (no contract) — for example BNB on BSC
            </span>
          </label>

          {!form.isNative && (
            <label className="field">
              <span>Contract address</span>
              <input
                className="input mono"
                required
                placeholder="0x…"
                spellCheck={false}
                value={form.contractAddress}
                onChange={(e) => set('contractAddress', e.target.value)}
              />
              <small className="faint">
                The token contract. Checked for a valid EIP-55 checksum on save, and verified
                on-chain by the desktop app before every send.
              </small>
              {fieldErrors.contractAddress && (
                <small className="danger">{fieldErrors.contractAddress}</small>
              )}
            </label>
          )}

          <div className="grid-2">
            <label className="field">
              <span>Decimals</span>
              <input
                className="input mono"
                type="number"
                min={0}
                max={36}
                required
                value={form.decimals}
                onChange={(e) => set('decimals', Number(e.target.value))}
              />
              <small className="faint">
                Must match the contract&apos;s own <code>decimals()</code>. A mismatch is rejected
                at send time.
              </small>
            </label>

            <label className="field">
              <span>Sort order</span>
              <input
                className="input mono"
                type="number"
                value={form.sortOrder}
                onChange={(e) => set('sortOrder', Number(e.target.value))}
              />
            </label>
          </div>

          <label className="field">
            <span>Explorer URL override</span>
            <input
              className="input mono"
              placeholder={network?.explorerUrl ?? 'https://bscscan.com'}
              value={form.explorerUrl}
              onChange={(e) => set('explorerUrl', e.target.value)}
            />
            <small className="faint">Leave blank to use the network&apos;s explorer.</small>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            <span>Enabled — visible in the desktop application</span>
          </label>

          {error && <div className="alert alert--danger">{error}</div>}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Saving…' : asset ? 'Save changes' : 'Add asset'}
          </button>
        </footer>
      </form>
    </div>
  );
}
