import React from 'react';
import type { WalletStatus } from '../../shared/types';
import { attempt, bridge } from '../lib/bridge';
import { Alert, Button, Card, Field, Modal } from '../components/ui';

/**
 * Wallet setup and unlock.
 *
 * The passphrase and any imported key are typed here, sent straight to the
 * main process, and never held in React state longer than the form's
 * lifetime. Nothing entered on this screen is logged or transmitted to the
 * backend.
 */
export function WalletGate({
  wallet,
  onChanged,
}: {
  wallet: WalletStatus | null;
  onChanged: () => Promise<void>;
}) {
  if (wallet?.hasWallet) {
    return <UnlockForm wallet={wallet} onChanged={onChanged} />;
  }
  return <SetupForm wallet={wallet} onChanged={onChanged} />;
}

function UnlockForm({
  wallet,
  onChanged,
}: {
  wallet: WalletStatus;
  onChanged: () => Promise<void>;
}) {
  const [passphrase, setPassphrase] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const { error: failure } = await attempt(bridge.wallet.unlock(passphrase));
    setPassphrase('');
    setBusy(false);

    if (failure) {
      setError(failure.message);
      return;
    }
    await onChanged();
  };

  return (
    <div className="container" style={{ maxWidth: 460, marginTop: '8vh' }}>
      <Card title="Unlock wallet">
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {wallet.address ? (
            <>
              Wallet <span className="mono">{wallet.address}</span>
            </>
          ) : (
            'Enter your vault passphrase to continue.'
          )}
        </p>

        <form onSubmit={submit} className="stack">
          <Field label="Vault passphrase" error={error}>
            <input
              className={`input${error ? ' input--invalid' : ''}`}
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setError(null);
              }}
            />
          </Field>

          <Button type="submit" variant="primary" loading={busy} disabled={!passphrase}>
            Unlock
          </Button>
        </form>

        {!wallet.osEncryptionAvailable && (
          <Alert tone="warning" title="OS encryption unavailable">
            Windows account encryption (DPAPI) could not be initialised, so the vault is protected
            by your passphrase alone. Choose a strong one and keep the vault file private.
          </Alert>
        )}
      </Card>
    </div>
  );
}

type Mode = 'create' | 'privateKey' | 'mnemonic';

function SetupForm({
  wallet,
  onChanged,
}: {
  wallet: WalletStatus | null;
  onChanged: () => Promise<void>;
}) {
  const [mode, setMode] = React.useState<Mode>('create');
  const [passphrase, setPassphrase] = React.useState('');
  const [confirmPassphrase, setConfirmPassphrase] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [derivationPath, setDerivationPath] = React.useState("m/44'/60'/0'/0/0");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [newMnemonic, setNewMnemonic] = React.useState<{ address: string; mnemonic: string } | null>(
    null,
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (passphrase !== confirmPassphrase) {
      setError('The two passphrases do not match.');
      return;
    }

    setBusy(true);

    const result =
      mode === 'create'
        ? await attempt(bridge.wallet.create(passphrase))
        : mode === 'privateKey'
          ? await attempt(bridge.wallet.importPrivateKey(secret, passphrase))
          : await attempt(bridge.wallet.importMnemonic(secret, passphrase, derivationPath));

    setBusy(false);

    if (result.error) {
      setError(result.error.message);
      return;
    }

    // Clear the secrets from component state immediately.
    setSecret('');
    setPassphrase('');
    setConfirmPassphrase('');

    if (mode === 'create' && 'mnemonic' in result.data) {
      setNewMnemonic(result.data as { address: string; mnemonic: string });
      return;
    }

    await onChanged();
  };

  return (
    <div className="container" style={{ maxWidth: 520, marginTop: '5vh' }}>
      <section className="card">
        <header className="card__header">
          <h2 className="card__title">Set up your sending wallet</h2>
        </header>

        <div className="tabs">
          {(
            [
              ['create', 'Create new'],
              ['privateKey', 'Private key'],
              ['mnemonic', 'Recovery phrase'],
            ] as [Mode, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`tab${mode === key ? ' tab--active' : ''}`}
              onClick={() => {
                setMode(key);
                setSecret('');
                setError(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="card__body">
          <Alert tone="info" title="Where your key is kept">
            Your key is encrypted with your passphrase and then with your Windows account
            encryption, and is stored only on this machine. It is never sent to the backend, never
            written to a log, and never leaves the application&apos;s signing process.
          </Alert>

          <form onSubmit={submit} className="stack">
            {mode === 'privateKey' && (
              <Field label="Private key" hint="64 hex characters, with or without 0x">
                <input
                  className="input input--mono"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secret}
                  onChange={(e) => {
                    setSecret(e.target.value);
                    setError(null);
                  }}
                />
              </Field>
            )}

            {mode === 'mnemonic' && (
              <>
                <Field label="Recovery phrase" hint="12–24 words, separated by spaces">
                  <textarea
                    className="input input--mono"
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                    value={secret}
                    onChange={(e) => {
                      setSecret(e.target.value);
                      setError(null);
                    }}
                  />
                </Field>
                <Field label="Derivation path" hint="Standard Ethereum account 0">
                  <input
                    className="input input--mono"
                    value={derivationPath}
                    onChange={(e) => setDerivationPath(e.target.value)}
                  />
                </Field>
              </>
            )}

            <Field
              label="Vault passphrase"
              hint="12+ characters, mixed case and a digit"
            >
              <input
                className="input"
                type="password"
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value);
                  setError(null);
                }}
              />
            </Field>

            <Field label="Confirm passphrase" error={error}>
              <input
                className={`input${error ? ' input--invalid' : ''}`}
                type="password"
                value={confirmPassphrase}
                onChange={(e) => {
                  setConfirmPassphrase(e.target.value);
                  setError(null);
                }}
              />
            </Field>

            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!passphrase || !confirmPassphrase || (mode !== 'create' && !secret)}
            >
              {mode === 'create' ? 'Create wallet' : 'Import wallet'}
            </Button>
          </form>

          {wallet && !wallet.osEncryptionAvailable && (
            <Alert tone="warning" title="OS encryption unavailable">
              Windows account encryption could not be initialised. Your vault will be protected by
              your passphrase alone.
            </Alert>
          )}
        </div>
      </section>

      {newMnemonic && (
        <RecoveryPhraseModal
          data={newMnemonic}
          onDone={async () => {
            setNewMnemonic(null);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * Shown exactly once, immediately after wallet creation. The phrase is not
 * stored in plaintext anywhere, so this is the user's only chance to record it.
 */
function RecoveryPhraseModal({
  data,
  onDone,
}: {
  data: { address: string; mnemonic: string };
  onDone: () => void;
}) {
  const [confirmed, setConfirmed] = React.useState(false);
  const words = data.mnemonic.split(' ');

  return (
    <Modal
      title="Write down your recovery phrase"
      subtitle="This is shown once and cannot be retrieved later."
      onClose={() => undefined}
      footer={
        <Button variant="primary" onClick={onDone} disabled={!confirmed}>
          I have written it down
        </Button>
      }
    >
      <Alert tone="warning">
        Anyone with these words controls this wallet. Write them on paper and store them somewhere
        safe. Do not photograph them, email them, or paste them into any website.
      </Alert>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
          padding: 14,
          background: 'var(--bg-inset)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
        }}
      >
        {words.map((word, index) => (
          <div key={`${index}-${word}`} className="mono" style={{ fontSize: 13 }}>
            <span className="faint" style={{ marginRight: 6 }}>
              {index + 1}.
            </span>
            {word}
          </div>
        ))}
      </div>

      <div className="rows">
        <div className="row">
          <span className="row__label">Address</span>
          <span className="row__value row__value--mono">{data.address}</span>
        </div>
      </div>

      <label className="inline" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span style={{ fontSize: 13 }}>
          I have written down my recovery phrase and understand it cannot be shown again.
        </span>
      </label>
    </Modal>
  );
}
