import React from 'react';
import { api, ApiError, type AdminUser, isAuthenticated, login, logout, refresh } from './lib/api';
import { AssetsPage } from './pages/AssetsPage';
import { NetworksPage } from './pages/NetworksPage';
import { ClientsPage } from './pages/ClientsPage';
import { AuditPage } from './pages/AuditPage';

type Tab = 'assets' | 'networks' | 'clients' | 'audit';

export function App() {
  const [user, setUser] = React.useState<AdminUser | null>(null);
  const [booting, setBooting] = React.useState(true);
  const [tab, setTab] = React.useState<Tab>('assets');
  const [version, setVersion] = React.useState<number | null>(null);

  React.useEffect(() => {
    void (async () => {
      setUser(await refresh());
      setBooting(false);
    })();
  }, []);

  const loadVersion = React.useCallback(async () => {
    if (!isAuthenticated()) return;
    try {
      const { version: next } = await api.assets.list();
      setVersion(next);
    } catch {
      /* non-critical */
    }
  }, []);

  React.useEffect(() => {
    void loadVersion();
  }, [loadVersion, tab]);

  if (booting) return <div className="center">Loading…</div>;
  if (!user) return <LoginPage onSignedIn={setUser} />;

  const readOnly = user.role !== 'ADMIN';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="mark">⚡</span>
          <div>
            <strong>Flash Sender</strong>
            <span className="topbar__sub">Asset configuration</span>
          </div>
        </div>

        <nav className="tabs">
          {(
            [
              ['assets', 'Assets'],
              ['networks', 'Networks'],
              ['clients', 'App keys'],
              ['audit', 'Audit log'],
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
          {version !== null && (
            <span className="chip" title="Desktop clients re-sync when this number changes">
              config v{version}
            </span>
          )}
          <span className="muted">{user.email}</span>
          {readOnly && <span className="chip chip--warn">read-only</span>}
          <button
            className="btn btn--ghost"
            onClick={async () => {
              await logout();
              setUser(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        {tab === 'assets' && <AssetsPage readOnly={readOnly} onChanged={loadVersion} />}
        {tab === 'networks' && <NetworksPage readOnly={readOnly} onChanged={loadVersion} />}
        {tab === 'clients' && <ClientsPage readOnly={readOnly} />}
        {tab === 'audit' && <AuditPage />}
      </main>
    </div>
  );
}

function LoginPage({ onSignedIn }: { onSignedIn: (user: AdminUser) => void }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      onSignedIn(await login(email, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="login__brand">
          <span className="mark">⚡</span>
          <h1>Flash Sender Admin</h1>
        </div>

        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <div className="alert alert--danger">{error}</div>}

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
