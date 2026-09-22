import React from 'react';
import { api, ApiError, type Asset, type Network } from '../lib/api';

/**
 * Adding a token that's private to this key.
 *
 * Unlike the shared catalog an admin curates, anything added here is
 * visible and usable only by this API key — never another key, and never
 * the admin dashboard's own Assets list. Adding one alone grants no
 * ability to send it yet: sending access still lives entirely on the
 * Limits screen, same as everything else in the catalog.
 */
export function TokensPage() {
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [networks, setNetworks] = React.useState<Network[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<Asset | null>(null);
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

  const removeToken = async (asset: Asset) => {
    if (!confirm(`Remove ${asset.symbol}? This only removes your own private token — nothing shared.`)) return;
    try {
      await api.assets.remove(asset.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove the token.');
    }
  };

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>My tokens</h2>
          <p className="muted">
            The shared catalog, plus tokens you've added yourself — those are private to your key
            alone, never seen by anyone else. Add one, then grant yourself a limit for it under
            "My sending limits" to actually send it.
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.symbol}</strong>
                    {a.isMine && (
                      <span className="chip" style={{ marginLeft: 8 }}>
                        yours
                      </span>
                    )}
                  </td>
                  <td>{a.name}</td>
                  <td className="faint">{a.network.name}</td>
                  <td className="mono faint">
                    {a.isNative ? 'native coin' : `${a.contractAddress?.slice(0, 10)}…`}
                  </td>
                  <td className="faint">{a.decimals}</td>
                  <td>
                    {a.isMine && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn--sm" onClick={() => setEditing(a)}>
                          Edit
                        </button>
                        <button className="btn btn--sm" onClick={() => void removeToken(a)}>
                          Remove
                        </button>
                      </div>
                    )}
                  </td>
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

      {editing && (
        <EditTokenForm
          asset={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
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
                It's private to your key now, but nothing can send it yet — including you. Head to
                "My sending limits" and grant yourself a limit for it.
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

/**
 * Editing never touches what identifies a token on-chain — its network and
 * contract address are fixed at creation. Only the label and whether it's
 * currently offered can change.
 */
function EditTokenForm({
  asset,
  onClose,
  onSaved,
}: {
  asset: Asset;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = React.useState(asset.name);
  const [symbol, setSymbol] = React.useState(asset.symbol);
  const [decimals, setDecimals] = React.useState(String(asset.decimals));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.assets.update(asset.id, { name, symbol, decimals: Number(decimals) });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop">
      <div className="modal" style={{ maxWidth: 520 }}>
        <header className="modal__head">
          <h3>Edit {asset.symbol}</h3>
        </header>

        <form className="modal__body" onSubmit={submit}>
          {error && <div className="alert alert--danger">{error}</div>}

          <div className="grid-2">
            <label className="field">
              <span>Symbol</span>
              <input
                className="input"
                required
                maxLength={16}
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
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          </div>

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
          </label>

          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            Network and contract address ({asset.contractAddress}) can't be changed here — remove
            the token and re-add it if you got either wrong.
          </p>

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--primary" type="submit" disabled={busy} style={{ flex: 1 }}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
