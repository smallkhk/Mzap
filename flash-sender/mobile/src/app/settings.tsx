import React from 'react';
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as api from '../lib/api';
import { AppError } from '../lib/errors';
import { getSettings, updateSettings, clearApiKey } from '../lib/settings';
import { EMAIL_URL, OWNER, PAYMENT_WARNING, TELEGRAM_URL, WHATSAPP_URL } from '../lib/branding';

export default function SettingsScreen() {
  const [apiBaseUrl, setApiBaseUrl] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [hasApiKey, setHasApiKey] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<string | null>(null);
  const [testError, setTestError] = React.useState<string | null>(null);

  const [saving, setSaving] = React.useState(false);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      const settings = await getSettings();
      setApiBaseUrl(settings.apiBaseUrl);
      setHasApiKey(settings.hasApiKey);
      setLoading(false);
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      await updateSettings({ apiBaseUrl, apiKey: apiKey || undefined });
      if (apiKey) {
        setApiKey('');
        setHasApiKey(true);
      }
      setSaveMessage('Settings saved.');
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    await clearApiKey();
    setHasApiKey(false);
    setSaveMessage('API key cleared.');
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const { version } = await api.testConnection();
      setTestResult(`Connected — config version ${version}.`);
    } catch (err) {
      setTestError(err instanceof AppError ? err.message : 'Could not reach the backend.');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#5b9dff" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Backend</Text>
      <View style={styles.card}>
        <Text style={styles.label}>API URL</Text>
        <TextInput
          style={styles.input}
          placeholder="https://your-backend.example.com"
          placeholderTextColor="#6a6a72"
          autoCapitalize="none"
          autoCorrect={false}
          value={apiBaseUrl}
          onChangeText={setApiBaseUrl}
        />

        <Text style={styles.label}>API key {hasApiKey && <Text style={styles.ok}>(set)</Text>}</Text>
        <TextInput
          style={styles.input}
          placeholder={hasApiKey ? 'Enter a new key to replace it' : 'Paste the key issued to you'}
          placeholderTextColor="#6a6a72"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          value={apiKey}
          onChangeText={setApiKey}
        />

        <TouchableOpacity style={styles.linkRow} onPress={() => Linking.openURL(WHATSAPP_URL)}>
          <Text style={styles.linkText}>Don't have an API key? Request one from {OWNER.name} on WhatsApp</Text>
        </TouchableOpacity>

        {saveMessage && <Text style={styles.okText}>{saveMessage}</Text>}

        <View style={styles.row}>
          <TouchableOpacity style={[styles.button, styles.flex1]} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color="#0a0a0c" /> : <Text style={styles.buttonText}>Save</Text>}
          </TouchableOpacity>
          {hasApiKey && (
            <TouchableOpacity
              style={[styles.button, styles.buttonSecondary, styles.flex1]}
              onPress={handleClearKey}
            >
              <Text style={styles.buttonSecondaryText}>Clear key</Text>
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity style={[styles.button, styles.buttonSecondary]} onPress={handleTest} disabled={testing}>
          {testing ? (
            <ActivityIndicator color="#e8e8ea" />
          ) : (
            <Text style={styles.buttonSecondaryText}>Test connection</Text>
          )}
        </TouchableOpacity>
        {testResult && <Text style={styles.okText}>{testResult}</Text>}
        {testError && <Text style={styles.errorText}>{testError}</Text>}
      </View>

      <Text style={styles.sectionTitle}>Support</Text>
      <View style={styles.card}>
        <Row label="Owner" value={OWNER.name} />
        <TouchableOpacity onPress={() => Linking.openURL(WHATSAPP_URL)}>
          <Row label="WhatsApp" value={OWNER.whatsapp} link />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL(TELEGRAM_URL)}>
          <Row label="Telegram" value={OWNER.telegram} link />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL(EMAIL_URL)}>
          <Row label="Email" value={OWNER.email} link />
        </TouchableOpacity>
        <Text style={styles.warning}>{PAYMENT_WARNING}</Text>
      </View>
    </ScrollView>
  );
}

function Row({ label, value, link }: { label: string; value: string; link?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, link && styles.linkText]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0a0a0c' },
  content: { padding: 16, gap: 10 },
  center: { flex: 1, backgroundColor: '#0a0a0c', alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { color: '#9a9aa2', fontSize: 13, fontWeight: '600', marginTop: 6 },
  card: {
    backgroundColor: '#161618',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2a2e',
    padding: 14,
    gap: 10,
  },
  label: { color: '#9a9aa2', fontSize: 13 },
  ok: { color: '#3fb950' },
  input: {
    backgroundColor: '#0a0a0c',
    borderWidth: 1,
    borderColor: '#2a2a2e',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    color: '#e8e8ea',
    fontSize: 14,
  },
  row: { flexDirection: 'row', gap: 10 },
  flex1: { flex: 1 },
  button: {
    backgroundColor: '#5b9dff',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: '#0a0a0c', fontWeight: '700', fontSize: 14 },
  buttonSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#2a2a2e' },
  buttonSecondaryText: { color: '#e8e8ea', fontWeight: '600', fontSize: 14 },
  linkRow: { marginTop: -2 },
  linkText: { color: '#5b9dff', fontSize: 13 },
  okText: { color: '#3fb950', fontSize: 13 },
  errorText: { color: '#e05a5a', fontSize: 13 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between' },
  value: { color: '#e8e8ea', fontSize: 13 },
  warning: { color: '#c9a227', fontSize: 12, lineHeight: 16, marginTop: 4 },
});
