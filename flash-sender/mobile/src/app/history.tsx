import React from 'react';
import {
  ActivityIndicator,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as api from '../lib/api';
import { AppError } from '../lib/errors';
import type { TransactionRecord } from '../lib/types';
import { SupportFooter } from '../components/Support';

const STATUS_COLOR: Record<string, string> = {
  CONFIRMED: '#3fb950',
  PENDING: '#c9a227',
  BROADCASTING: '#c9a227',
  SIGNING: '#c9a227',
  AWAITING_CONFIRMATION: '#9a9aa2',
  PREPARING: '#9a9aa2',
  FAILED: '#e05a5a',
  REJECTED: '#e05a5a',
};

export default function HistoryScreen() {
  const [transactions, setTransactions] = React.useState<TransactionRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const data = await api.fetchTransactions();
      setTransactions(data);
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not load transaction history.');
    }
  }, []);

  React.useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#5b9dff" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#5b9dff" />}
    >
      {error && <Text style={styles.errorText}>{error}</Text>}

      {!error && !transactions.length && (
        <Text style={styles.hint}>No transactions yet. Anything you send will show up here.</Text>
      )}

      {transactions.map((tx) => (
        <View key={tx.id} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.amount}>
              {tx.amountDisplay} {tx.symbol}
            </Text>
            <View style={[styles.statusPill, { borderColor: STATUS_COLOR[tx.status] ?? '#7a7a82' }]}>
              <Text style={[styles.statusText, { color: STATUS_COLOR[tx.status] ?? '#7a7a82' }]}>
                {tx.status}
              </Text>
            </View>
          </View>

          <Text style={styles.toLabel}>To</Text>
          <Text style={styles.toAddress}>{tx.toAddress}</Text>

          {tx.errorMessage && <Text style={styles.errorText}>{tx.errorMessage}</Text>}

          <View style={styles.cardFooter}>
            <Text style={styles.date}>{new Date(tx.submittedAt).toLocaleString()}</Text>
            {tx.explorerUrl && (
              <TouchableOpacity onPress={() => Linking.openURL(tx.explorerUrl!)}>
                <Text style={styles.link}>View on explorer</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ))}

      <SupportFooter />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0a0a0c' },
  content: { padding: 16, gap: 10 },
  center: { flex: 1, backgroundColor: '#0a0a0c', alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: '#161618',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2a2e',
    padding: 14,
    gap: 6,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  amount: { color: '#e8e8ea', fontSize: 16, fontWeight: '700' },
  statusPill: { borderWidth: 1, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 10 },
  statusText: { fontSize: 11, fontWeight: '700' },
  toLabel: { color: '#7a7a82', fontSize: 11, marginTop: 4 },
  toAddress: { color: '#e8e8ea', fontSize: 13, fontFamily: 'monospace' },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  date: { color: '#7a7a82', fontSize: 11 },
  link: { color: '#5b9dff', fontSize: 12, fontWeight: '600' },
  errorText: { color: '#e05a5a', fontSize: 13 },
  hint: { color: '#7a7a82', fontSize: 13, textAlign: 'center', marginTop: 20 },
});
