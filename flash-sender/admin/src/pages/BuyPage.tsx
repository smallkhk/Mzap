import React from 'react';
import { api, ApiError, type Asset, type BuyQuote, type BuySettings } from '../lib/api';

/**
 * The admin's own buy tool — labelled "Generate tokens" everywhere a
 * customer might see the word, since "swap" invites the wrong expectation
 * for what this is. Spends the shared custodial wallet's own BNB/USDT to
 * acquire a token by contract address; the purchase lands back in that
 * same wallet. No markup applies here — there is no one to charge.
 */
export function BuyPage({ readOnly }: { readOnly: boolean }) {
  const [wallet, setWallet] = React.useState<{ custodial: boolean; address: string | null } | null>(
    null,
  );
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [settings, setSettings] = React.useState<BuySettings | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const [walletBody, assetsBody, settingsBody] = await Promise.all([
        api.wallet.get(),
        api.assets.list(),
        api.buy.settings(),
      ]);
      setWallet(walletBody);
      setAssets(assetsBody.assets.filter((a) => a.enabled));
      setSettings(settingsBody);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the buy tool.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div className="page" />;

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h2>Generate tokens</h2>
          <p className="muted">
            Spend the shared wallet's own balance to acquire a token by contract address. Quotes
            are compared against 1inch; the purchase executes via LI.FI.
          </p>
        </div>
      </div>

      {error && <div className="alert alert--danger">{error}</div>}

      {!wallet?.custodial ? (
        <div className="alert alert--warn">
          This deployment has no server wallet configured, so there is nothing for the admin buy
          tool to spend from. See docs/CUSTODIAL.md to set one up.
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="chip chip--ok">custodial</span>
              <span className="mono">{wallet.address}</span>
            </div>
          </div>

          <BuyForm
            assets={assets}
            spendAssetLabel="the shared wallet"
            onQuote={(input) => api.buy.quote(input)}
            onExecute={(quoteRef) => api.buy.execute(quoteRef)}
          />
        </>
      )}

      {!readOnly && settings && <BuySettingsCard settings={settings} onSaved={setSettings} />}
    </div>
  );
}

function BuySettingsCard({
  settings,
  onSaved,
}: {
  settings: BuySettings;
  onSaved: (s: BuySettings) => void;
}) {
  const [markupPercent, setMarkupPercent] = React.useState((settings.buyMarkupBps / 100).toString());
  const [profitAddress, setProfitAddress] = React.useState(settings.profitAddress ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const bps = Math.round(Number(markupPercent) * 100);
      const next = await api.buy.setSettings({
        buyMarkupBps: bps,
        profitAddress: profitAddress.trim() || null,
      });
      onSaved(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ marginTop: 0, fontSize: 15 }}>Buy settings</h3>
      <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
        Applies only to customer buys in the portal. This markup is real, not a display number:
        it's taken from the USDT or BNB a customer spends, before the swap happens, and sent
        on-chain to the profit address — the customer keeps 100% of whatever the token side
        actually returns. Leaving the profit address empty disables the fee even if a markup is
        set — a swap never sends funds to nowhere.
      </p>

      {error && <div className="alert alert--danger">{error}</div>}
      {saved && !error && <div className="alert alert--info">Saved.</div>}

      <form onSubmit={submit} style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
        <div className="grid-2">
          <label className="field">
            <span>Markup</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder="2.5"
              value={markupPercent}
              onChange={(e) => setMarkupPercent(e.target.value)}
            />
            <small className="faint">Percent, e.g. 2.5 for 2.5%.</small>
          </label>
          <label className="field">
            <span>Profit address</span>
            <input
              className="input mono"
              placeholder="0x…"
              value={profitAddress}
              onChange={(e) => setProfitAddress(e.target.value)}
            />
            <small className="faint">Where the markup is sent, per buy.</small>
          </label>
        </div>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </div>
  );
}

/**
 * Shared by both the admin and portal buy pages — the flow is identical,
 * only which wallet it spends from (and whether a markup applies) differs,
 * and that's entirely a backend concern this component never has to know.
 */
export function BuyForm({
  assets,
  spendAssetLabel,
  onQuote,
  onExecute,
  walletNotReady,
}: {
  assets: Asset[];
  spendAssetLabel: string;
  onQuote: (input: {
    spendAssetId: string;
    tokenAddress: string;
    amountIn: string;
  }) => Promise<BuyQuote>;
  onExecute: (quoteRef: string) => Promise<{ creditedDisplay: string; tokenSymbol: string | null; explorerUrl: string }>;
  walletNotReady?: string;
}) {
  // Buying only accepts the chain's native coin or USDT to spend — enforced
  // server-side too, so this is a picker restriction, not the actual gate.
  const spendable = assets.filter((a) => a.isNative || a.symbol.toUpperCase() === 'USDT');
  const [spendAssetId, setSpendAssetId] = React.useState(spendable[0]?.id ?? '');
  const [tokenAddress, setTokenAddress] = React.useState('');
  const [amountIn, setAmountIn] = React.useState('');
  const [quote, setQuote] = React.useState<BuyQuote | null>(null);
  const [result, setResult] = React.useState<{ creditedDisplay: string; tokenSymbol: string | null; explorerUrl: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const getQuote = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setQuote(null);
    try {
      setQuote(await onQuote({ spendAssetId, tokenAddress, amountIn }));
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
      setResult(await onExecute(quote.quoteRef));
      setQuote(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The purchase failed.');
    } finally {
      setBusy(false);
    }
  };

  if (walletNotReady) {
    return <div className="alert alert--warn">{walletNotReady}</div>;
  }

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
            <span>Spend from {spendAssetLabel}</span>
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
                <th>You'd receive</th>
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

          {quote.markupBps > 0 && (
            <div className="alert alert--warn" style={{ margin: 0 }}>
              A {(quote.markupBps / 100).toFixed(2)}% fee — {quote.feeAmountDisplay} {quote.spendSymbol} —
              is taken from the spend amount before swapping. {quote.swapAmountDisplay} {quote.spendSymbol}{' '}
              actually gets swapped; you're credited the full {quote.buyerAmountOutDisplay}{' '}
              {quote.tokenSymbol} that comes back, none of it skimmed.
            </div>
          )}

          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            Best output found via <strong>{quote.executionTool}</strong> — checked against every
            route LI.FI could find for this pair, not just its default pick. Quote expires in{' '}
            {quote.expiresInSeconds}s — the rate is re-checked on confirm.
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
