import React from 'react';
import type { TransactionRecord, TxState } from '../../shared/types';
import { attempt, bridge } from '../lib/bridge';
import { formatDateTime, formatRelative, shortAddress, shortHash, TX_STATES } from '../lib/format';
import { Alert, Button, Copyable, Empty, ExplorerLink, Modal, Row, StatusBadge } from '../components/ui';

/**
 * Transaction history.
 *
 * Everything here is a record of something this application actually did.
 * A row with no hash is one that never reached the network, and it says so
 * rather than showing a placeholder.
 */
export function HistoryPage() {
  const [records, setRecords] = React.useState<TransactionRecord[]>([]);
  const [selected, setSelected] = React.useState<TransactionRecord | null>(null);
  const [loading, setLoading] = React.useState(true);

  const [search, setSearch] = React.useState('');
  const [network, setNetwork] = React.useState('');
  const [asset, setAsset] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [fromDate, setFromDate] = React.useState('');

  const load = React.useCallback(async () => {
    const { data } = await attempt(bridge.history.list());
    if (data) setRecords(data);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Refresh as transactions settle in the background.
  React.useEffect(() => bridge.on.transferProgress(() => void load()), [load]);

  const networks = React.useMemo(
    () => [...new Set(records.map((r) => r.networkName))].sort(),
    [records],
  );
  const symbols = React.useMemo(() => [...new Set(records.map((r) => r.symbol))].sort(), [records]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();

    return records.filter((record) => {
      if (network && record.networkName !== network) return false;
      if (asset && record.symbol !== asset) return false;
      if (status && record.status !== status) return false;
      if (fromDate && record.submittedAt < new Date(fromDate).toISOString()) return false;

      if (term) {
        const haystack = [
          record.txHash,
          record.toAddress,
          record.fromAddress,
          record.symbol,
          record.amountDisplay,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(term)) return false;
      }

      return true;
    });
  }, [records, search, network, asset, status, fromDate]);

  const clearFilters = () => {
    setSearch('');
    setNetwork('');
    setAsset('');
    setStatus('');
    setFromDate('');
  };

  const hasFilters = Boolean(search || network || asset || status || fromDate);

  return (
    <div className="container container--wide">
      <section className="card">
        <header className="card__header">
          <h2 className="card__title">
            Transaction history
            {records.length > 0 && (
              <span className="faint" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>
                {filtered.length} of {records.length}
              </span>
            )}
          </h2>
          {hasFilters && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </header>

        <div className="filters">
          <input
            className="input"
            placeholder="Search hash, address, amount…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="select" value={network} onChange={(e) => setNetwork(e.target.value)}>
            <option value="">All networks</option>
            {networks.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select className="select" value={asset} onChange={(e) => setAsset(e.target.value)}>
            <option value="">All assets</option>
            {symbols.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
          </select>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(TX_STATES).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </select>
        </div>

        <div className="filters" style={{ gridTemplateColumns: '1fr', borderBottom: 'none' }}>
          <label className="inline" style={{ fontSize: 12.5 }}>
            <span className="muted">From date</span>
            <input
              className="input"
              type="date"
              style={{ width: 'auto' }}
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </label>
        </div>

        {loading ? (
          <div className="empty">
            <span className="spinner" aria-hidden />
          </div>
        ) : !filtered.length ? (
          <Empty
            icon={records.length ? '🔍' : '↗'}
            title={records.length ? 'No transactions match these filters' : 'No transactions yet'}
            hint={
              records.length
                ? 'Try widening your search.'
                : 'Transactions you send will be recorded here.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Asset</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Recipient</th>
                  <th>Network</th>
                  <th>Status</th>
                  <th>Transaction hash</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((record) => (
                  <tr key={record.clientRef} onClick={() => setSelected(record)}>
                    <td title={formatDateTime(record.submittedAt)}>
                      {formatRelative(record.submittedAt)}
                    </td>
                    <td style={{ fontWeight: 600 }}>{record.symbol}</td>
                    <td className="num">{record.amountDisplay}</td>
                    <td className="mono" style={{ fontSize: 12.5 }}>
                      {shortAddress(record.toAddress)}
                    </td>
                    <td className="muted">{record.networkName}</td>
                    <td>
                      <StatusBadge status={record.status} />
                    </td>
                    <td className="mono" style={{ fontSize: 12.5 }}>
                      {record.txHash ? (
                        shortHash(record.txHash)
                      ) : (
                        <span className="faint">not broadcast</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && <DetailsModal record={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function DetailsModal({ record, onClose }: { record: TransactionRecord; onClose: () => void }) {
  const descriptor = TX_STATES[record.status as TxState];

  return (
    <Modal
      title="Transaction details"
      subtitle={formatDateTime(record.submittedAt)}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {record.explorerUrl && (
            <Button
              variant="primary"
              onClick={() => void bridge.shell.openExternal(record.explorerUrl!)}
            >
              View on explorer →
            </Button>
          )}
        </>
      }
    >
      <Alert
        tone={
          descriptor.tone === 'neutral'
            ? 'info'
            : (descriptor.tone as 'success' | 'warning' | 'danger' | 'info')
        }
        title={descriptor.label}
      >
        {record.errorMessage ?? descriptor.description}
      </Alert>

      <div className="rows">
        <Row label="Amount" value={`${record.amountDisplay} ${record.symbol}`} emphasis />

        <div className="divider" />

        <Row
          label="Transaction hash"
          value={
            record.txHash ? (
              <Copyable value={record.txHash} display={record.txHash} />
            ) : (
              <span className="faint">None — this transaction was never broadcast</span>
            )
          }
        />
        <Row label="From" value={<Copyable value={record.fromAddress} />} />
        <Row label="To" value={<Copyable value={record.toAddress} />} />

        <div className="divider" />

        <Row label="Asset" value={`${record.symbol} (${record.isNative ? 'native' : 'token'})`} />
        {record.contractAddress && (
          <Row label="Contract" value={<Copyable value={record.contractAddress} />} />
        )}
        <Row label="Decimals" value={record.decimals} mono />
        <Row label="Network" value={`${record.networkName} · chain ${record.chainId}`} />

        <div className="divider" />

        <Row
          label="Block"
          value={record.blockNumber ?? <span className="faint">not yet mined</span>}
          mono
        />
        <Row label="Confirmations" value={record.confirmations} mono />
        <Row
          label="Network fee"
          value={record.feeDisplay ?? <span className="faint">not yet known</span>}
          mono
        />
        {record.gasUsed && <Row label="Gas used" value={record.gasUsed} mono />}
        {record.nonce !== null && <Row label="Nonce" value={record.nonce} mono />}

        <div className="divider" />

        <Row label="Submitted" value={formatDateTime(record.submittedAt)} />
        {record.broadcastAt && <Row label="Broadcast" value={formatDateTime(record.broadcastAt)} />}
        {record.confirmedAt && <Row label="Confirmed" value={formatDateTime(record.confirmedAt)} />}
      </div>

      {record.errorCode && (
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          Error code: <span className="mono">{record.errorCode}</span>
        </p>
      )}

      {record.explorerUrl && (
        <div style={{ textAlign: 'center' }}>
          <ExplorerLink url={record.explorerUrl} />
        </div>
      )}
    </Modal>
  );
}
