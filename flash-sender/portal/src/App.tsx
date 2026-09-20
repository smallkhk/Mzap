import React from 'react';
import { api, type Account, ApiError, isSignedIn, signIn, signOut } from './lib/api';
import { TokensPage } from './pages/TokensPage';
import { LimitsPage } from './pages/LimitsPage';

type Tab = 'limits' | 'tokens';

export function App() {
  const [account, setAccount] = React.useState<Account | null>(null);
  const [booting, setBooting] = React.useState(true);
  const [tab, setTab] = React.useState<Tab>('limits');

  React.useEffect(() => {
    void (async () => {
      if (isSignedIn()) {
        try {
          setAccount(await api.me());
        } catch {
          /* the stored key is no longer valid; fall back to the login screen */
        }
      }
      setBooting(false);
    })();
  }, []);

  if (booting) return <div className="center">Loading…</div>;
  if (!account) return <LoginPage onSignedIn={setAccount} />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="mark">⚡</span>
          <div>
            <strong>Flash Sender</strong>
            <span className="topbar__sub">{account.name}</span>
          </div>
        </div>

        <nav className="tabs">
          {(
            [
              ['limits', 'My sending limits'],
              ['tokens', 'My tokens'],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              className={`tab${tab === key ? ' tab--active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="topbar__right">
          <span className="mono faint">{account.keyPrefix}…</span>
          <button
            className="btn btn--ghost"
            onClick={() => {
              signOut();
              setAccount(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        {account.custodial && (
          <div className="page" style={{ maxWidth: 1180, margin: '0 auto 0', paddingBottom: 0 }}>
            <div className="alert alert--info">
              Sending from the shared wallet at <code className="mono">{account.address}</code>. Your
              installation can only send what a limit below allows.
            </div>
          </div>
        )}

        {tab === 'limits' && <LimitsPage />}
        {tab === 'tokens' && <TokensPage />}
      </main>
    </div>
  );
}

function LoginPage({ onSignedIn }: { onSignedIn: (account: Account) => void }) {
  const [key, setKey] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      onSignedIn(await signIn(key));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
      setKey('');
    }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="login__brand">
          <span className="mark">⚡</span>
          <h1>Flash Sender — My Account</h1>
        </div>

        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          Paste the API key your administrator issued you. This panel only ever acts on that one
          key — it cannot see or create any other.
        </p>

        {error && <div className="alert alert--danger">{error}</div>}

        <label className="field">
          <span>API key</span>
          <input
            className="input mono"
            type="password"
            autoFocus
            autoComplete="off"
            required
            placeholder="fs_…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
