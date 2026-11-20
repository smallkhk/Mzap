import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { EMAIL_URL, OWNER, PAYMENT_WARNING, TELEGRAM_URL, WHATSAPP_URL } from '../lib/branding';

/**
 * Rendered on every screen so there is never a moment where this app is on
 * screen without saying who it belongs to and how to reach them — same
 * intent as the desktop app's SupportFooter.
 */
export function SupportFooter({ compact }: { compact?: boolean }) {
  return (
    <View style={[styles.footer, compact && styles.footerCompact]}>
      <Text style={styles.owner}>
        Flash Sender by <Text style={styles.ownerName}>{OWNER.name}</Text>
      </Text>
      <View style={styles.links}>
        <TouchableOpacity onPress={() => Linking.openURL(WHATSAPP_URL)}>
          <Text style={styles.link}>WhatsApp</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL(TELEGRAM_URL)}>
          <Text style={styles.link}>Telegram {OWNER.telegram}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL(EMAIL_URL)}>
          <Text style={styles.link}>{OWNER.email}</Text>
        </TouchableOpacity>
      </View>
      {!compact && <Text style={styles.warning}>{PAYMENT_WARNING}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: '#2a2a2e',
    gap: 6,
  },
  footerCompact: {
    borderTopWidth: 0,
    paddingVertical: 8,
  },
  owner: {
    color: '#9a9aa2',
    fontSize: 13,
  },
  ownerName: {
    color: '#e8e8ea',
    fontWeight: '600',
  },
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  link: {
    color: '#5b9dff',
    fontSize: 13,
    fontWeight: '500',
  },
  warning: {
    color: '#c9a227',
    fontSize: 12,
    lineHeight: 16,
  },
});
