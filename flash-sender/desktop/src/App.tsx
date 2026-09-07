import React from 'react';
import type { AppConfig, AppSettings, WalletStatus } from '../shared/types';
import { attempt, bridge } from './lib/bridge';
import { SendPage } from './pages/SendPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { WalletGate } from './pages/WalletGate';
import { Alert, Button } from './components/ui';

type Page = 'send' | 'history' | 'settings';

export function App() {
  const [page, setPage] = React.useState<Page>('send');
  const [wallet, setWallet] = React.useState<WalletStatus | null>(null);
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [configIssues, setConfigIssues] = React.useState<string[]>([]);
  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refreshWallet = React.useCallback(async () => {
    const { data } = await attempt(bridge.wallet.status());
    if (data) setWallet(data);
  }, []);

  const refreshSettings = React.useCallback(async () => {
    const { data } = await attempt(bridge.settings.get());
    if (data) setSettings(data);
    return data;
  }, []);

  const loadConfig = React.useCallback(async () => {
    const { data } = await attempt(bridge.config.get());
    if (data?.config) {
      setConfig(data.config);
      setConfigIssues(data.rejected);
    }
  }, []);

  React.useEffect(() => {
    void (async () => {
      await Promise.all([refreshWallet(), refreshSettings(), loadConfig()]);
      setLoading(false);
    })();
  }, [refreshWallet, refreshSettings, loadConfig]);

  // Live updates pushed from the main process.
  React.useEffect(() => {
    const offLocked = bridge.on.walletLocked(() => {
      void refreshWallet();
      setNotice('The wallet locked itself after a period of inactivity.');
    });

    const offConfig = bridge.on.configChanged(({ config: next, rejected }) => {
      setConfig(next);
      setConfigIssues(rejected);
    });

    return () => {
      offLocked();
      offConfig();
    };
  }, [refreshWallet]);

  // Apply the theme preference.
  React.useEffect(() => {
    const theme = settings?.theme ?? 'system';
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    document.documentElement.dataset.theme = resolved;
  }, [settings?.theme]);

  if (loading) {
    return (
      <div className="app">
        <div className="empty" style={{ marginTop: '25vh' }}>
          <span className="spinner" style={{ width: 22, height: 22 }} aria-hidden />
        </div>
      </div>
    );
  }

  const backendConfigured = Boolean(settings?.apiBaseUrl && settings.hasApiKey);
  const walletReady = wallet?.hasWallet && wallet.unlocked;

  /**
   * Every network currently in play is a testnet, or at least one is mainnet.
   * The banner is unconditional — the user should never have to work out
   * which environment they are in.
   */
  const hasMainnet = config?.networks.some((n) => !n.isTestnet) ?? false;
  const mainnetArmed = hasMainnet && (settings?.allowMainnet ?? false);

  return (
    <div className="app">
      <div className={`env-banner env-banner--${mainnetArmed ? 'mainnet' : 'testnet'}`}>
        {mainnetArmed ? '● Production — mainnet enabled, real funds' : '● Development — testnet only'}
      </div>

      <header className="app__header">
        <div className="brand">
          <div className="brand__mark" aria-hidden>
            ⚡
          </div>
          <h1 className="brand__name">Flash Sender by Nora</h1>
        </div>

        <nav className="app__nav">
          {(['send', 'history', 'settings'] as Page[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`nav-btn${page === key ? ' nav-btn--active' : ''}`}
              onClick={() => setPage(key)}
            >
              {key === 'send' ? 'Send' : key === 'history' ? 'History' : 'Settings'}
            </button>
          ))}
        </nav>

        <div className="inline">
          {wallet?.unlocked ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await bridge.wallet.lock();
                void refreshWallet();
              }}
            >
              🔒 Lock
            </Button>
          ) : (
            <span className="badge badge--neutral">
              <span className="dot" aria-hidden /> Locked
            </span>
          )}
        </div>
      </header>

      <main className="app__body">
        {notice && (
          <div className="container" style={{ marginBottom: 'var(--space-4)' }}>
            <Alert tone="info">
              {notice}{' '}
              <button type="button" className="link" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </Alert>
          </div>
        )}

        {page === 'settings' ? (
          <SettingsPage
            settings={settings}
            wallet={wallet}
            config={config}
            onSettingsChanged={async () => {
              await refreshSettings();
              await loadConfig();
            }}
            onWalletChanged={refreshWallet}
          />
        ) : !backendConfigured ? (
          <div className="container">
            <Alert tone="warning" title="Backend not configured">
              This application gets its list of sendable assets from your backend. Open{' '}
              <button type="button" className="link" onClick={() => setPage('settings')}>
                Settings
              </button>{' '}
              and enter your API address and key to continue.
            </Alert>
          </div>
        ) : !walletReady ? (
          <WalletGate wallet={wallet} onChanged={refreshWallet} />
        ) : page === 'send' ? (
          <SendPage
            config={config}
            configIssues={configIssues}
            onRefreshConfig={loadConfig}
            onOpenHistory={() => setPage('history')}
          />
        ) : (
          <HistoryPage />
        )}
      </main>
    </div>
  );
}
