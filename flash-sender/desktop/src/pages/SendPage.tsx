import React from 'react';
import type {
  AppConfig,
  AssetConfig,
  TransactionRecord,
  TransferQuote,
  TransferProgressEvent,
} from '../../shared/types';
import { attempt, bridge } from '../lib/bridge';
import { shortAddress, TX_STATES } from '../lib/format';
import { Alert, Badge, Button, Card, Copyable, ExplorerLink, Field, Modal, Row } from '../components/ui';

interface Props {
  config: AppConfig | null;
  configIssues: string[];
  onRefreshConfig: () => Promise<void>;
  onOpenHistory: () => void;
}

interface BalanceState {
  address: string | null;
  asset: { raw: string; formatted: string; symbol: string; decimals: number } | null;
  native: { raw: string; formatted: string; symbol: string; decimals: number } | null;
  /** Present in custodial mode: what this installation may still send. */
  limit?: { maxPerTx: string; maxPerDay: string } | null;
}

export function SendPage({ config, configIssues, onRefreshConfig, onOpenHistory }: Props) {
  const assets = React.useMemo(() => config?.assets.filter((a) => a.enabled) ?? [], [config]);

  const networks = React.useMemo(() => {
    const seen = new Map<string, AssetConfig['network']>();
    for (const asset of assets) seen.set(asset.network.key, asset.network);
    return [...seen.values()];
  }, [assets]);

  const [networkKey, setNetworkKey] = React.useState<string>('');
  const [assetId, setAssetId] = React.useState<string>('');
  const [recipient, setRecipient] = React.useState('');
  const [amount, setAmount] = React.useState('');

  const [balance, setBalance] = React.useState<BalanceState | null>(null);
  const [balanceError, setBalanceError] = React.useState<string | null>(null);
  const [chainOk, setChainOk] = React.useState<boolean | null>(null);
  const [chainError, setChainError] = React.useState<string | null>(null);
  const [maxNote, setMaxNote] = React.useState<string | null>(null);

  const [preparing, setPreparing] = React.useState(false);
  const [quote, setQuote] = React.useState<TransferQuote | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  const [sending, setSending] = React.useState(false);
  const [result, setResult] = React.useState<TransactionRecord | null>(null);
  const [progress, setProgress] = React.useState<TransferProgressEvent | null>(null);

  // Default the selection to the first available network/asset.
  React.useEffect(() => {
    if (!networkKey && networks.length) setNetworkKey(networks[0]!.key);
  }, [networks, networkKey]);

  const networkAssets = React.useMemo(
    () => assets.filter((a) => a.network.key === networkKey),
    [assets, networkKey],
  );

  React.useEffect(() => {
    if (networkAssets.length && !networkAssets.some((a) => a.id === assetId)) {
      setAssetId(networkAssets[0]!.id);
    }
  }, [networkAssets, assetId]);

  const asset = React.useMemo(() => assets.find((a) => a.id === assetId) ?? null, [assets, assetId]);

  // Balances and connectivity, refreshed when the asset changes and on an interval.
  const loadBalance = React.useCallback(async () => {
    if (!assetId) return;

    const [balanceResult, statusResult] = await Promise.all([
      attempt(bridge.chain.balance(assetId)),
      attempt(bridge.chain.status(assetId)),
    ]);

    if (balanceResult.data) {
      setBalance(balanceResult.data);
      setBalanceError(null);
    } else {
      setBalance(null);
      setBalanceError(balanceResult.error.message);
    }

    if (statusResult.data) {
      setChainOk(statusResult.data.connected);
      setChainError(statusResult.data.error);
    }
  }, [assetId]);

  React.useEffect(() => {
    void loadBalance();
    const timer = setInterval(() => void loadBalance(), 20_000);
    return () => clearInterval(timer);
  }, [loadBalance]);

  // Live transaction progress.
  React.useEffect(
    () =>
      bridge.on.transferProgress((event) => {
        setProgress(event);
        if (['CONFIRMED', 'FAILED'].includes(event.state)) void loadBalance();
      }),
    [loadBalance],
  );

  const reset = () => {
    setRecipient('');
    setAmount('');
    setMaxNote(null);
    setQuote(null);
    setFormError(null);
    setResult(null);
    setProgress(null);
  };

  const handleMax = async () => {
    if (!assetId) return;
    setFormError(null);

    const { data, error } = await attempt(bridge.transfer.max(assetId));
    if (error) {
      setFormError(error.message);
      return;
    }
    setAmount(data.amount);
    setMaxNote(data.note);
  };

  /** Runs all validation and estimation, then opens the confirmation dialog. */
  const handlePrepare = async () => {
    if (!assetId) return;

    setPreparing(true);
    setFormError(null);

    const { data, error } = await attempt(
      bridge.transfer.prepare({ assetId, recipient, amount }),
    );

    setPreparing(false);

    if (error) {
      setFormError(error.message);
      return;
    }
    setQuote(data);
  };

  /** The user confirmed. This is the point of no return. */
  const handleConfirm = async () => {
    if (!quote) return;

    setSending(true);
    const { data, error } = await attempt(bridge.transfer.confirm(quote.clientRef));
    setSending(false);
    setQuote(null);

    if (error) {
      setFormError(error.message);
      return;
    }

    setResult(data);
    setRecipient('');
    setAmount('');
    setMaxNote(null);
    void loadBalance();
  };

  const handleCancel = async () => {
    if (quote) await bridge.transfer.reject(quote.clientRef);
    setQuote(null);
  };

  if (!config || !assets.length) {
    return (
      <div className="container">
        <Card title="No assets available">
          <p className="muted" style={{ margin: 0 }}>
            Your backend has not published any enabled assets yet. Add one in the admin dashboard —
            it will appear here automatically, with no reinstall needed.
          </p>
          <Button variant="secondary" onClick={onRefreshConfig}>
            Refresh configuration
          </Button>
        </Card>
      </div>
    );
  }

  const canSubmit = Boolean(assetId && recipient.trim() && amount.trim() && !preparing);

  return (
    <div className="container">
      {configIssues.length > 0 && (
        <Alert tone="warning" title="Some assets were rejected">
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {configIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Alert>
      )}

      {/* --- Wallet -------------------------------------------------------- */}
      <Card
        title="Wallet"
        action={
          chainOk === null ? null : chainOk ? (
            <Badge tone="success">Connected</Badge>
          ) : (
            <Badge tone="danger">Disconnected</Badge>
          )
        }
      >
        <div className="rows">
          <Row
            label="Address"
            value={
              balance?.address ? (
                <Copyable value={balance.address} display={shortAddress(balance.address, 10, 8)} />
              ) : (
                '—'
              )
            }
          />
          <Row
            label="Network"
            value={
              asset ? (
                <span className="inline" style={{ justifyContent: 'flex-end' }}>
                  {asset.network.name}
                  <Badge tone={asset.network.isTestnet ? 'warning' : 'danger'}>
                    {asset.network.isTestnet ? 'Testnet' : 'Mainnet'}
                  </Badge>
                </span>
              ) : (
                '—'
              )
            }
          />
          <Row
            label={`Balance${balance?.native ? ` (${balance.native.symbol})` : ''}`}
            value={balance?.native ? balance.native.formatted : '—'}
            mono
          />
          {balance?.limit && (
            <Row
              label="Your sending limit"
              value={`${balance.limit.maxPerTx} per transfer · ${balance.limit.maxPerDay} per day`}
            />
          )}
        </div>

        {chainError && <Alert tone="danger">{chainError}</Alert>}
        {balanceError && <Alert tone="danger">{balanceError}</Alert>}
      </Card>

      {/* --- Send ---------------------------------------------------------- */}
      <Card title="Send asset">
        <div className="grid-2">
          <Field label="Network">
            <select
              className="select"
              value={networkKey}
              onChange={(e) => {
                setNetworkKey(e.target.value);
                setFormError(null);
              }}
            >
              {networks.map((network) => (
                <option key={network.key} value={network.key}>
                  {network.name}
                  {network.isTestnet ? ' (testnet)' : ''}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Asset">
            <select
              className="select"
              value={assetId}
              onChange={(e) => {
                setAssetId(e.target.value);
                setFormError(null);
                setMaxNote(null);
              }}
            >
              {networkAssets.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.symbol} — {option.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {asset && (
          <div className="rows" style={{ paddingBottom: 4 }}>
            <Row label="Symbol" value={asset.symbol} />
            <Row
              label="Type"
              value={asset.isNative ? `Native coin of ${asset.network.name}` : 'Token contract'}
            />
            {asset.contractAddress && (
              <Row
                label="Contract"
                value={
                  <Copyable
                    value={asset.contractAddress}
                    display={shortAddress(asset.contractAddress, 10, 8)}
                  />
                }
              />
            )}
            <Row label="Decimals" value={asset.decimals} mono />
            <Row label="Chain ID" value={asset.chainId} mono />
          </div>
        )}

        <div className="divider" />

        <Field
          label="Recipient"
          hint={asset ? `On ${asset.network.name}` : undefined}
        >
          <input
            className="input input--mono"
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              setFormError(null);
            }}
          />
        </Field>

        <Field
          label="Amount"
          hint={
            balance?.asset
              ? `Available: ${balance.asset.formatted} ${balance.asset.symbol}`
              : undefined
          }
        >
          <div className="input-group">
            <input
              className="input input--mono"
              placeholder="0.00"
              inputMode="decimal"
              spellCheck={false}
              autoComplete="off"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setMaxNote(null);
                setFormError(null);
              }}
            />
            <Button variant="secondary" onClick={handleMax} disabled={!assetId}>
              MAX
            </Button>
          </div>
        </Field>

        {maxNote && <p className="faint" style={{ margin: '-6px 0 0', fontSize: 12.5 }}>{maxNote}</p>}

        {formError && <Alert tone="danger">{formError}</Alert>}

        <Button variant="send" onClick={handlePrepare} loading={preparing} disabled={!canSubmit}>
          {preparing ? 'Checking…' : 'Send'}
        </Button>

        <p className="faint" style={{ margin: 0, fontSize: 12, textAlign: 'center' }}>
          You will see the full details and the estimated fee before anything is signed.
        </p>
      </Card>

      {/* --- Confirmation --------------------------------------------------- */}
      {quote && (
        <ConfirmDialog
          quote={quote}
          sending={sending}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}

      {/* --- Result --------------------------------------------------------- */}
      {result && (
        <ResultDialog
          record={result}
          progress={progress}
          onClose={reset}
          onOpenHistory={() => {
            reset();
            onOpenHistory();
          }}
        />
      )}
    </div>
  );
}

/**
 * The confirmation screen.
 *
 * Shows every field that determines where the money goes, including the
 * contract address, so the user is checking the actual transaction rather
 * than a summary of it.
 */
function ConfirmDialog({
  quote,
  sending,
  onConfirm,
  onCancel,
}: {
  quote: TransferQuote;
  sending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [acknowledged, setAcknowledged] = React.useState(false);
  const needsAcknowledgement = !quote.network.isTestnet;

  return (
    <Modal
      title="Confirm transaction"
      subtitle="Check every detail. Once broadcast, a transaction cannot be recalled."
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={sending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            loading={sending}
            disabled={needsAcknowledgement && !acknowledged}
          >
            {sending ? 'Sending…' : 'Confirm and send'}
          </Button>
        </>
      }
    >
      <div className="rows">
        <Row
          label="Amount"
          value={`${quote.amountDisplay} ${quote.symbol}`}
          emphasis
        />
        <div className="divider" />
        <Row
          label="Network"
          value={
            <span className="inline" style={{ justifyContent: 'flex-end' }}>
              {quote.network.name}
              <Badge tone={quote.network.isTestnet ? 'warning' : 'danger'}>
                {quote.network.isTestnet ? 'Testnet' : 'Mainnet'}
              </Badge>
            </span>
          }
        />
        <Row label="Chain ID" value={quote.network.chainId} mono />
        <Row label="Asset" value={`${quote.symbol} · ${quote.isNative ? 'native coin' : 'token'}`} />
        {quote.contractAddress && (
          <Row label="Contract" value={quote.contractAddress} mono />
        )}
        <div className="divider" />
        <Row label="From" value={quote.from} mono />
        <Row label="To" value={quote.to} mono />
        <div className="divider" />
        <Row
          label="Estimated network fee"
          value={`${quote.estimatedFeeDisplay} ${quote.nativeSymbol}`}
          mono
        />
        <Row label="Gas limit" value={quote.gasLimit} mono />
      </div>

      {quote.warnings.map((warning) => (
        <Alert key={warning} tone="warning">
          {warning}
        </Alert>
      ))}

      {needsAcknowledgement && (
        <label
          className="inline"
          style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 13 }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            I have checked the recipient address and understand this sends real funds on{' '}
            {quote.network.name}, irreversibly.
          </span>
        </label>
      )}
    </Modal>
  );
}

/** Live state of the transaction just submitted. */
function ResultDialog({
  record,
  progress,
  onClose,
  onOpenHistory,
}: {
  record: TransactionRecord;
  progress: TransferProgressEvent | null;
  onClose: () => void;
  onOpenHistory: () => void;
}) {
  const state = progress?.state ?? record.status;
  const descriptor = TX_STATES[state];
  const txHash = progress?.txHash ?? record.txHash;

  return (
    <Modal
      title={descriptor.label}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onOpenHistory}>
            Open history
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <Alert
        tone={
          descriptor.tone === 'neutral' ? 'info' : (descriptor.tone as 'success' | 'warning' | 'danger' | 'info')
        }
      >
        {progress?.message ?? descriptor.description}
      </Alert>

      <div className="rows">
        <Row label="Amount" value={`${record.amountDisplay} ${record.symbol}`} emphasis />
        <Row label="To" value={record.toAddress} mono />
        <Row label="Network" value={record.networkName} />
        {txHash ? (
          <Row label="Transaction hash" value={txHash} mono />
        ) : (
          <Row
            label="Transaction hash"
            value={<span className="faint">Not broadcast — no hash exists</span>}
          />
        )}
        {progress?.blockNumber && <Row label="Block" value={progress.blockNumber} mono />}
        {progress?.confirmations !== undefined && progress.confirmations > 0 && (
          <Row label="Confirmations" value={progress.confirmations} mono />
        )}
      </div>

      {record.explorerUrl && (
        <div style={{ textAlign: 'center' }}>
          <ExplorerLink url={record.explorerUrl}>View transaction on explorer</ExplorerLink>
        </div>
      )}
    </Modal>
  );
}
