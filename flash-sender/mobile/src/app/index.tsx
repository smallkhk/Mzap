import React from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as api from '../lib/api';
import { AppError } from '../lib/errors';
import type { AppConfig, AssetConfig, ServerWalletInfo, TransferQuote } from '../lib/types';
import { SupportFooter } from '../components/Support';

export default function SendScreen() {
  const router = useRouter();

  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [configIssues, setConfigIssues] = React.useState<string[]>([]);
  const [configError, setConfigError] = React.useState<string | null>(null);
  const [loadingConfig, setLoadingConfig] = React.useState(true);

  const [assetId, setAssetId] = React.useState('');
  const [recipient, setRecipient] = React.useState('');
  const [amount, setAmount] = React.useState('');

  const [wallet, setWallet] = React.useState<ServerWalletInfo | null>(null);
  const [walletError, setWalletError] = React.useState<string | null>(null);

  const [preparing, setPreparing] = React.useState(false);
  const [quote, setQuote] = React.useState<TransferQuote | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);

  const [sending, setSending] = React.useState(false);
  const [result, setResult] = React.useState<{ txHash: string | null; explorerUrl: string | null } | null>(
    null,
  );

  const assets = React.useMemo(() => config?.assets.filter((a) => a.enabled) ?? [], [config]);
  const asset = React.useMemo(() => assets.find((a) => a.id === assetId) ?? null, [assets, assetId]);

  const loadConfig = React.useCallback(async () => {
    setLoadingConfig(true);
    setConfigError(null);
    try {
      const { config: cfg, rejected } = await api.fetchConfig();
      setConfig(cfg);
      setConfigIssues(rejected);
      if (!assetId && cfg.assets.length) setAssetId(cfg.assets[0]!.id);
    } catch (err) {
      setConfigError(err instanceof AppError ? err.message : 'Could not load configuration.');
    } finally {
      setLoadingConfig(false);
    }
  }, [assetId]);

  React.useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const loadWallet = React.useCallback(async () => {
    if (!assetId) return;
    try {
      const data = await api.fetchServerWallet(assetId);
      setWallet(data);
      setWalletError(null);
    } catch (err) {
      setWallet(null);
      setWalletError(err instanceof AppError ? err.message : 'Could not load wallet balance.');
    }
  }, [assetId]);

  React.useEffect(() => {
    void loadWallet();
    const timer = setInterval(() => void loadWallet(), 20_000);
    return () => clearInterval(timer);
  }, [loadWallet]);

  const reset = () => {
    setRecipient('');
    setAmount('');
    setQuote(null);
    setFormError(null);
    setResult(null);
  };

  const handlePrepare = async () => {
    if (!assetId) return;
    setPreparing(true);
    setFormError(null);
    try {
      const data = await api.prepareSend({ assetId, recipient, amount });
      setQuote(data);
    } catch (err) {
      setFormError(err instanceof AppError ? err.message : 'Could not prepare this transfer.');
    } finally {
      setPreparing(false);
    }
  };

  const handleConfirm = async () => {
    if (!quote) return;
    setSending(true);
    try {
      const data = await api.confirmSend(quote.clientRef);
      setResult({ txHash: data.txHash, explorerUrl: data.explorerUrl });
      setQuote(null);
      setRecipient('');
      setAmount('');
      void loadWallet();
    } catch (err) {
      setFormError(err instanceof AppError ? err.message : 'Could not send this transfer.');
    } finally {
      setSending(false);
    }
  };

  if (loadingConfig) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#5b9dff" />
        <SupportFooter compact />
      </View>
    );
  }

  if (configError || !config || !assets.length) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>
          {configError ?? 'Your backend has not published any enabled assets yet.'}
        </Text>
        <TouchableOpacity style={styles.button} onPress={loadConfig}>
          <Text style={styles.buttonText}>Retry</Text>
        </TouchableOpacity>
        <SupportFooter compact />
      </View>
    );
  }

  const canSubmit = Boolean(assetId && recipient.trim() && amount.trim() && !preparing);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {configIssues.length > 0 && (
        <View style={styles.warnBox}>
          {configIssues.map((issue) => (
            <Text key={issue} style={styles.warnText}>
              {issue}
            </Text>
          ))}
        </View>
      )}

      <Text style={styles.sectionTitle}>Asset</Text>
      <View style={styles.assetRow}>
        {assets.map((item) => (
          <TouchableOpacity
            key={item.id}
            style={[styles.assetChip, item.id === assetId && styles.assetChipActive]}
            onPress={() => {
              setAssetId(item.id);
              setFormError(null);
            }}
          >
            <Text style={[styles.assetChipText, item.id === assetId && styles.assetChipTextActive]}>
              {item.symbol}
            </Text>
            <Text style={styles.assetChipNetwork}>{item.network.name}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {asset && (
        <View style={styles.card}>
          <Row label="Network" value={asset.network.name} />
          <Row label="Type" value={asset.isNative ? 'Native coin' : 'Token contract'} />
          <Row
            label={`Balance${wallet?.asset ? ` (${wallet.asset.symbol})` : ''}`}
            value={wallet?.asset ? wallet.asset.formatted : '—'}
            mono
          />
          {wallet?.limit && (
            <Row
              label="Sending limit"
              value={`${wallet.limit.maxPerTx} / tx · ${wallet.limit.maxPerDay} / day`}
            />
          )}
        </View>
      )}

      {walletError && <Text style={styles.errorText}>{walletError}</Text>}

      <Text style={styles.sectionTitle}>Recipient</Text>
      <TextInput
        style={styles.input}
        placeholder="0x…"
        placeholderTextColor="#6a6a72"
        autoCapitalize="none"
        autoCorrect={false}
        value={recipient}
        onChangeText={(v) => {
          setRecipient(v);
          setFormError(null);
        }}
      />

      <Text style={styles.sectionTitle}>Amount</Text>
      <TextInput
        style={styles.input}
        placeholder="0.00"
        placeholderTextColor="#6a6a72"
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={(v) => {
          setAmount(v);
          setFormError(null);
        }}
      />

      {formError && <Text style={styles.errorText}>{formError}</Text>}

      <TouchableOpacity
        style={[styles.button, !canSubmit && styles.buttonDisabled]}
        disabled={!canSubmit}
        onPress={handlePrepare}
      >
        {preparing ? (
          <ActivityIndicator color="#0a0a0c" />
        ) : (
          <Text style={styles.buttonText}>Send</Text>
        )}
      </TouchableOpacity>

      <Text style={styles.hint}>
        You will see the full details and the estimated fee before anything is signed.
      </Text>

      <SupportFooter />

      <Modal visible={Boolean(quote)} transparent animationType="fade" onRequestClose={() => setQuote(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <ScrollView>
              <Text style={styles.modalTitle}>Confirm transaction</Text>
              <Text style={styles.modalSubtitle}>
                Check every detail. Once broadcast, a transaction cannot be recalled.
              </Text>

              {quote && (
                <View style={styles.card}>
                  <Row label="Amount" value={`${quote.amountDisplay} ${quote.symbol}`} emphasis />
                  <Row label="Network" value={quote.network.name} />
                  <Row label="Chain ID" value={String(quote.network.chainId)} mono />
                  <Row label="From" value={quote.from} mono />
                  <Row label="To" value={quote.to} mono />
                  <Row
                    label="Estimated network fee"
                    value={`${quote.estimatedFeeDisplay} ${quote.nativeSymbol}`}
                    mono
                  />
                </View>
              )}

              {quote?.warnings.map((warning) => (
                <Text key={warning} style={styles.warnText}>
                  {warning}
                </Text>
              ))}

              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.button, styles.buttonSecondary, styles.flex1]}
                  onPress={() => setQuote(null)}
                  disabled={sending}
                >
                  <Text style={styles.buttonSecondaryText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.button, styles.flex1]}
                  onPress={handleConfirm}
                  disabled={sending}
                >
                  {sending ? (
                    <ActivityIndicator color="#0a0a0c" />
                  ) : (
                    <Text style={styles.buttonText}>Confirm and send</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={Boolean(result)} transparent animationType="fade" onRequestClose={reset}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Transaction sent</Text>
            {result?.txHash ? (
              <Row label="Transaction hash" value={result.txHash} mono />
            ) : (
              <Text style={styles.hint}>Not broadcast — no hash exists.</Text>
            )}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.button, styles.buttonSecondary, styles.flex1]}
                onPress={() => {
                  reset();
                  router.push('/history');
                }}
              >
                <Text style={styles.buttonSecondaryText}>Open history</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.button, styles.flex1]} onPress={reset}>
                <Text style={styles.buttonText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  mono,
  emphasis,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasis?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          mono && styles.mono,
          emphasis && styles.rowValueEmphasis,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0a0a0c' },
  content: { padding: 16, gap: 10 },
  center: { flex: 1, backgroundColor: '#0a0a0c', alignItems: 'center', justifyContent: 'center', gap: 14 },
  sectionTitle: { color: '#9a9aa2', fontSize: 13, fontWeight: '600', marginTop: 6 },
  assetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  assetChip: {
    borderWidth: 1,
    borderColor: '#2a2a2e',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  assetChipActive: { borderColor: '#5b9dff', backgroundColor: '#152235' },
  assetChipText: { color: '#e8e8ea', fontWeight: '600' },
  assetChipTextActive: { color: '#5b9dff' },
  assetChipNetwork: { color: '#7a7a82', fontSize: 11, marginTop: 2 },
  card: {
    backgroundColor: '#161618',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2a2e',
    padding: 14,
    gap: 8,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  rowLabel: { color: '#9a9aa2', fontSize: 13 },
  rowValue: { color: '#e8e8ea', fontSize: 13, flexShrink: 1, textAlign: 'right' },
  rowValueEmphasis: { fontSize: 16, fontWeight: '700' },
  mono: { fontFamily: 'monospace' },
  input: {
    backgroundColor: '#161618',
    borderWidth: 1,
    borderColor: '#2a2a2e',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    color: '#e8e8ea',
    fontSize: 15,
  },
  errorText: { color: '#e05a5a', fontSize: 13 },
  warnBox: { backgroundColor: '#2a2410', borderRadius: 10, padding: 12, gap: 4 },
  warnText: { color: '#c9a227', fontSize: 12 },
  button: {
    backgroundColor: '#5b9dff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: '#0a0a0c', fontWeight: '700', fontSize: 15 },
  buttonSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#2a2a2e' },
  buttonSecondaryText: { color: '#e8e8ea', fontWeight: '600', fontSize: 15 },
  hint: { color: '#7a7a82', fontSize: 12, textAlign: 'center' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#161618',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2a2a2e',
    padding: 18,
    maxHeight: '85%',
    gap: 12,
  },
  modalTitle: { color: '#e8e8ea', fontSize: 18, fontWeight: '700' },
  modalSubtitle: { color: '#9a9aa2', fontSize: 13 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  flex1: { flex: 1 },
});
