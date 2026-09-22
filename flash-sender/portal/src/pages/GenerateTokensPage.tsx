import React from 'react';
import { api, ApiError, type Asset, type BuyQuote, type BuyResult } from '../lib/api';

/**
 * "Generate tokens" — buying a token with this installation's own deposit
 * wallet.
 *
 * Three states in order: no deposit address yet → generate one and fund it
 * externally; funded, no quote yet → pick a token and an amount; quoted →
 * confirm. The wallet is generated once and reused for every future buy —
 * this page never asks for it twice.
 */
export function GenerateTokensPage() {
  const [address, setAddress] = React.useState<string | null>(null);
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [generating, setGenerating] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [me, assetsBody] = await Promise.all([api.me(), api.assets.list()]);
      setAddress(me.buyWalletAddress);
      setAssets(assetsBody.assets.filter((a) => a.enabled));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const { address: next } = await api.buy.wallet();
      setAddress(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to generate a deposit address.');
    } finally {
      setGenerating(false);
    }
  };

  if (loading) return <div className="page" />;

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>Generate tokens</h2>
          <p className="muted">
            Buy a token by contract address, using your own deposit wallet. Rates are compared
            against 1inch; the purchase executes via LI.FI.
          </p>
        </div>
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      {!address ? (
        <div className="card" style={{ padding: 16, display: 'grid', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13.5 }}>
            You need a deposit address before you can buy anything. It's generated once and is
            yours alone — fund it from any wallet, and it's ready to spend from immediately.
          </p>
          <button className="btn btn--primary" onClick={generate} disabled={generating} style={{ alignSelf: 'start' }}>
            {generating ? 'Generating…' : 'Generate my deposit address'}
          </button>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 14, display: 'grid', gap: 8 }}>
            <span className="faint" style={{ fontSize: 12 }}>Your deposit address</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <code className="mono">{address}</code>
              <button className="btn btn--sm" onClick={() => void navigator.clipboard.writeText(address)}>
                Copy
              </button>
            </div>
            <p className="faint" style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>
              Send BNB or USDT here from any wallet before buying. What you buy lands back in
              this same address.
            </p>
          </div>

          <BuyForm assets={assets} />
        </>
      )}
    </div>
  );
}

function BuyForm({ assets }: { assets: Asset[] }) {
  // Buying only accepts the chain's native coin or USDT to spend — enforced
  // server-side too, so this is a picker restriction, not the actual gate.
  const spendable = assets.filter((a) => a.isNative || a.symbol.toUpperCase() === 'USDT');
  const [spendAssetId, setSpendAssetId] = React.useState(spendable[0]?.id ?? '');
  const [tokenAddress, setTokenAddress] = React.useState('');
  const [amountIn, setAmountIn] = React.useState('');
  const [quote, setQuote] = React.useState<BuyQuote | null>(null);
  const [result, setResult] = React.useState<BuyResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const getQuote = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setQuote(null);
    try {
      setQuote(await api.buy.quote({ spendAssetId, tokenAddress, amountIn }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to get a quote.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.buy.execute(quote.quoteRef));
      setQuote(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The purchase failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 14 }}>
      {error && <div className="alert alert--danger">{error}</div>}

      {result && (
        <div className="alert alert--info">
          Bought {result.creditedDisplay} {result.tokenSymbol ?? 'TOKEN'}.{' '}
          <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="link">
            View on explorer
          </a>
        </div>
      )}

      {!quote ? (
        <form onSubmit={getQuote} style={{ display: 'grid', gap: 12 }}>
          <label className="field">
            <span>Spend</span>
            <select
              className="input"
              value={spendAssetId}
              required
              onChange={(e) => setSpendAssetId(e.target.value)}
            >
              <option value="" disabled>
                Choose an asset…
              </option>
              {spendable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.symbol} — {a.network.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Token contract address</span>
            <input
              className="input mono"
              placeholder="0x…"
              required
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
            />
          </label>

          <label className="field">
            <span>Amount to spend</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder="0.1"
              required
              value={amountIn}
              onChange={(e) => setAmountIn(e.target.value)}
            />
          </label>

          <button className="btn btn--primary" type="submit" disabled={busy || !spendAssetId}>
            {busy ? 'Getting quote…' : 'Get quote'}
          </button>
        </form>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Market rate would give</th>
              </tr>
            </thead>
            <tbody>
              {quote.comparisons.map((c) => (
                <tr key={c.source} className={c.source === quote.executesVia ? '' : 'row--disabled'}>
                  <td>
                    {c.source}
                    {c.source === quote.executesVia && (
                      <span className="chip chip--ok" style={{ marginLeft: 8 }}>
                        executes
                      </span>
                    )}
                  </td>
                  <td>
                    {c.amountOutDisplay} {quote.tokenSymbol ?? 'TOKEN'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="alert alert--info" style={{ margin: 0 }}>
            You will receive {quote.buyerAmountOutDisplay} {quote.tokenSymbol ?? 'TOKEN'}.
          </div>

          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            Best output found via <strong>{quote.executionTool}</strong> — checked against every
            route available for this pair, not just one router's default pick. Quote expires in{' '}
            {quote.expiresInSeconds}s — the rate is re-checked when you confirm.
          </p>

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" type="button" onClick={() => setQuote(null)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn--primary" type="button" onClick={confirm} disabled={busy} style={{ flex: 1 }}>
              {busy ? 'Buying…' : `Buy — get ${quote.buyerAmountOutDisplay} ${quote.tokenSymbol ?? 'TOKEN'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
