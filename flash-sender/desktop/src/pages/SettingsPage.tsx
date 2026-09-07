import React from 'react';
import type { AppConfig, AppSettings, WalletStatus } from '../../shared/types';
import { attempt, bridge } from '../lib/bridge';
import { formatDateTime } from '../lib/format';
import { Alert, Button, Card, Field, Modal, Row } from '../components/ui';

interface Props {
  settings: AppSettings | null;
  wallet: WalletStatus | null;
  config: AppConfig | null;
  onSettingsChanged: () => Promise<void>;
  onWalletChanged: () => Promise<void>;
}

export function SettingsPage({ settings, wallet, config, onSettingsChanged, onWalletChanged }: Props) {
  const [apiBaseUrl, setApiBaseUrl] = React.useState(settings?.apiBaseUrl ?? '');
  const [apiKey, setApiKey] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [message, setMessage] = React.useState<{ tone: 'success' | 'danger'; text: string } | null>(
    null,
  );
  const [confirmMainnet, setConfirmMainnet] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  React.useEffect(() => {
    setApiBaseUrl(settings?.apiBaseUrl ?? '');
  }, [settings?.apiBaseUrl]);

  const save = async (patch: Parameters<typeof bridge.settings.update>[0]) => {
    setSaving(true);
    setMessage(null);

    const { error } = await attempt(bridge.settings.update(patch));
    setSaving(false);

    if (error) {
      setMessage({ tone: 'danger', text: error.message });
      return false;
    }

    await onSettingsChanged();
    return true;
  };

  const saveBackend = async () => {
    const saved = await save({
      apiBaseUrl,
      ...(apiKey ? { apiKey } : {}),
    });

    if (saved) {
      setApiKey('');
      setMessage({ tone: 'success', text: 'Backend settings saved.' });
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setMessage(null);

    const { data, error } = await attempt(bridge.config.testConnection());
    setTesting(false);

    setMessage(
      error
        ? { tone: 'danger', text: error.message }
        : { tone: 'success', text: `Connected. Configuration version ${data.version}.` },
    );
  };

  const refreshConfig = async () => {
    setTesting(true);
    const { data, error } = await attempt(bridge.config.refresh());
    setTesting(false);

    setMessage(
      error
        ? { tone: 'danger', text: error.message }
        : {
            tone: 'success',
            text: `Loaded ${data.config.assets.length} asset(s) at version ${data.config.version}.`,
          },
    );
    await onSettingsChanged();
  };

  return (
    <div className="container">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      {/* --- Backend -------------------------------------------------------- */}
      <Card title="Backend">
        <Alert tone="info">
          The API address and key are stored encrypted on this machine, not compiled into the
          application. Point a build at a different backend by changing them here.
        </Alert>

        <Field label="API base URL" hint="Must be https, except on localhost">
          <input
            className="input input--mono"
            placeholder="https://api.example.com"
            spellCheck={false}
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
          />
        </Field>

        <Field
          label="API key"
          hint={settings?.hasApiKey ? 'A key is stored — enter a new one to replace it' : 'Required'}
        >
          <input
            className="input input--mono"
            type="password"
            placeholder={settings?.hasApiKey ? '••••••••••••••••' : 'fsk_…'}
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>

        <div className="inline">
          <Button variant="primary" onClick={saveBackend} loading={saving}>
            Save
          </Button>
          <Button variant="secondary" onClick={testConnection} loading={testing}>
            Test connection
          </Button>
          <Button variant="ghost" onClick={refreshConfig} loading={testing}>
            Refresh assets now
          </Button>
        </div>

        {config && (
          <div className="rows">
            <div className="divider" />
            <Row label="Configuration version" value={config.version} mono />
            <Row label="Assets" value={config.assets.length} mono />
            <Row label="Networks" value={config.networks.length} mono />
            <Row label="Last synced" value={formatDateTime(config.fetchedAt)} />
          </div>
        )}
      </Card>

      {/* --- Environment ---------------------------------------------------- */}
      <Card title="Environment">
        <div className="row">
          <div>
            <div style={{ fontWeight: 600 }}>Allow mainnet networks</div>
            <div className="faint" style={{ fontSize: 12.5, maxWidth: 460 }}>
              While this is off, the application refuses to send on any non-testnet network, even
              if your backend publishes one. Keep it off during development.
            </div>
          </div>
          <label className="inline" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings?.allowMainnet ?? false}
              onChange={(e) => {
                if (e.target.checked) setConfirmMainnet(true);
                else void save({ allowMainnet: false });
              }}
            />
          </label>
        </div>

        <div className="divider" />

        <Field label="Theme">
          <select
            className="select"
            value={settings?.theme ?? 'system'}
            onChange={(e) => void save({ theme: e.target.value as AppSettings['theme'] })}
          >
            <option value="system">Match Windows</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </Field>

        <div className="grid-2">
          <Field label="Lock wallet after" hint="seconds idle">
            <input
              className="input"
              type="number"
              min={30}
              max={3600}
              defaultValue={settings?.autoLockSeconds ?? 300}
              onBlur={(e) => void save({ autoLockSeconds: Number(e.target.value) })}
            />
          </Field>

          <Field label="Check for config changes" hint="seconds">
            <input
              className="input"
              type="number"
              min={15}
              max={3600}
              defaultValue={settings?.configPollSeconds ?? 60}
              onBlur={(e) => void save({ configPollSeconds: Number(e.target.value) })}
            />
          </Field>
        </div>

        <Field
          label="Confirmations before marking a transaction confirmed"
          hint="1–64 blocks"
        >
          <input
            className="input"
            type="number"
            min={1}
            max={64}
            defaultValue={settings?.minConfirmations ?? 1}
            onBlur={(e) => void save({ minConfirmations: Number(e.target.value) })}
          />
        </Field>
      </Card>

      {/* --- Wallet --------------------------------------------------------- */}
      <Card title="Wallet">
        <div className="rows">
          <Row label="Address" value={wallet?.address ?? 'No wallet configured'} mono />
          <Row label="Status" value={wallet?.unlocked ? 'Unlocked' : 'Locked'} />
          <Row
            label="Windows account encryption"
            value={wallet?.osEncryptionAvailable ? 'Active (DPAPI)' : 'Unavailable'}
          />
        </div>

        {wallet?.hasWallet && (
          <>
            <div className="divider" />
            <div className="inline">
              <Button
                variant="secondary"
                onClick={async () => {
                  await bridge.wallet.lock();
                  await onWalletChanged();
                }}
                disabled={!wallet.unlocked}
              >
                Lock now
              </Button>
              <Button variant="danger" onClick={() => setRemoving(true)}>
                Remove wallet…
              </Button>
            </div>
          </>
        )}
      </Card>

      {confirmMainnet && (
        <Modal
          title="Enable mainnet sending?"
          onClose={() => setConfirmMainnet(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmMainnet(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  await save({ allowMainnet: true });
                  setConfirmMainnet(false);
                }}
              >
                Enable mainnet
              </Button>
            </>
          }
        >
          <Alert tone="danger" title="This enables transfers of real funds">
            With mainnet enabled, transactions sent from this application move real assets on live
            networks. They are irreversible and cannot be cancelled once broadcast.
          </Alert>
          <p style={{ margin: 0, fontSize: 13 }} className="muted">
            Before enabling, confirm you have tested your setup on a testnet, and that every asset
            in your backend has the correct contract address, decimals and chain ID.
          </p>
        </Modal>
      )}

      {removing && <RemoveWalletModal onClose={() => setRemoving(false)} onRemoved={onWalletChanged} />}
    </div>
  );
}

function RemoveWalletModal({
  onClose,
  onRemoved,
}: {
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const [passphrase, setPassphrase] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const remove = async () => {
    setBusy(true);
    setError(null);

    const { error: failure } = await attempt(bridge.wallet.remove(passphrase));
    setBusy(false);
    setPassphrase('');

    if (failure) {
      setError(failure.message);
      return;
    }

    await onRemoved();
    onClose();
  };

  return (
    <Modal
      title="Remove this wallet?"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={remove} loading={busy} disabled={!passphrase}>
            Remove wallet
          </Button>
        </>
      }
    >
      <Alert tone="danger" title="This deletes the encrypted key from this machine">
        If you do not have the recovery phrase or private key written down elsewhere, the funds in
        this wallet become permanently inaccessible. Nobody — including this application&apos;s
        author — can recover them.
      </Alert>

      <Field label="Confirm with your vault passphrase" error={error}>
        <input
          className={`input${error ? ' input--invalid' : ''}`}
          type="password"
          value={passphrase}
          onChange={(e) => {
            setPassphrase(e.target.value);
            setError(null);
          }}
        />
      </Field>
    </Modal>
  );
}
