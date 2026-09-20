import React from 'react';
import { api, ApiError, type Asset, type Network } from '../lib/api';

/**
 * Adding a token to the shared catalog.
 *
 * This list is shared infrastructure, not a per-client setting — every
 * installation sees the same catalog. What stays per-client is *sending
 * access* to any given entry, which lives entirely on the Limits screen.
 * Adding a token here does not grant anyone, including this key, the
 * ability to send it.
 */
export function TokensPage() {
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [networks, setNetworks] = React.useState<Network[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [adding, setAdding] = React.useState(false);
  const [justAdded, setJustAdded] = React.useState<Asset | null>(null);

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
      setError(err instanceof ApiError ? err.message : 'Failed to load the token catalog.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>My tokens</h2>
          <p className="muted">
            Every token every installation can see. Add one your administrator hasn't yet — then
            grant yourself a limit for it under "My sending limits" to actually send it.
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setAdding(true)}>
          + Add a token
        </button>
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      {!loading && (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Name</th>
                <th>Network</th>
                <th>Contract</th>
                <th>Decimals</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.symbol}</strong>
                  </td>
                  <td>{a.name}</td>
                  <td className="faint">{a.network.name}</td>
                  <td className="mono faint">
                    {a.isNative ? 'native coin' : `${a.contractAddress?.slice(0, 10)}…`}
                  </td>
                  <td className="faint">{a.decimals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddTokenForm
          networks={networks}
          onClose={() => setAdding(false)}
          onAdded={async (asset) => {
            setAdding(false);
            setJustAdded(asset);
            await load();
          }}
        />
      )}

      {justAdded && (
        <div className="backdrop">
          <div className="modal" style={{ maxWidth: 440 }}>
            <header className="modal__head">
              <h3>{justAdded.symbol} added</h3>
            </header>
            <div className="modal__body">
              <div className="alert alert--info">
                It's in the catalog, but nothing can send it yet — including you. Head to "My
                sending limits" and grant yourself a limit for it.
              </div>
            </div>
            <footer className="modal__foot">
              <button className="btn btn--primary" onClick={() => setJustAdded(null)}>
                Got it
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function AddTokenForm({
  networks,
  onClose,
  onAdded,
}: {
  networks: Network[];
  onClose: () => void;
  onAdded: (asset: Asset) => Promise<void>;
}) {
  const [assetId, setAssetId] = React.useState('');
  const [name, setName] = React.useState('');
  const [symbol, setSymbol] = React.useState('');
  const [networkKey, setNetworkKey] = React.useState(networks[0]?.key ?? '');
  const [contractAddress, setContractAddress] = React.useState('');
  const [decimals, setDecimals] = React.useState('18');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { asset } = await api.assets.create({
        assetId,
        name,
        symbol,
        networkKey,
        contractAddress,
        decimals: Number(decimals),
      });
      await onAdded(asset);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add the token.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop">
      <div className="modal" style={{ maxWidth: 520 }}>
        <header className="modal__head">
          <h3>Add a token</h3>
        </header>

        <form className="modal__body" onSubmit={submit}>
          {error && <div className="alert alert--danger">{error}</div>}

          <label className="field">
            <span>Network</span>
            <select
              className="input"
              value={networkKey}
              required
              onChange={(e) => setNetworkKey(e.target.value)}
            >
              {networks.map((n) => (
                <option key={n.key} value={n.key}>
                  {n.name} {n.isTestnet ? '(testnet)' : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="grid-2">
            <label className="field">
              <span>Symbol</span>
              <input
                className="input"
                required
                maxLength={16}
                placeholder="USDT"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                required
                maxLength={80}
                placeholder="Tether USD"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>Contract address</span>
            <input
              className="input mono"
              required
              placeholder="0x…"
              value={contractAddress}
              onChange={(e) => setContractAddress(e.target.value)}
            />
            <small className="faint">The token's contract on the network chosen above.</small>
          </label>

          <label className="field">
            <span>Decimals</span>
            <input
              className="input"
              type="number"
              min={0}
              max={36}
              required
              value={decimals}
              onChange={(e) => setDecimals(e.target.value)}
            />
            <small className="faint">
              Check this against the contract — a wrong value here is refused when anyone tries to
              send the token, so it fails safe, but check it anyway.
            </small>
          </label>

          <label className="field">
            <span>Slug (used internally)</span>
            <input
              className="input mono"
              required
              placeholder="usdt-bsc"
              pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
              value={assetId}
              onChange={(e) => setAssetId(e.target.value.toLowerCase())}
            />
            <small className="faint">Lowercase letters, digits and hyphens. Must be unique.</small>
          </label>

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" type="submit" disabled={busy} style={{ flex: 1 }}>
              {busy ? 'Adding…' : 'Add token'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
