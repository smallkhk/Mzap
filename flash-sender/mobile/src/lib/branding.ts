/**
 * The operator's own identity and contact details — same content as the
 * desktop app's shared/branding.ts, kept in sync by hand since this is a
 * separate Expo project with its own dependency tree.
 */
export const OWNER = {
  name: 'Nora',
  whatsapp: '+2348153329197',
  telegram: '@noraphillip',
  email: 'brightkteam92@gmail.com',
} as const;

export const WHATSAPP_URL = `https://wa.me/${OWNER.whatsapp.replace(/[^\d]/g, '')}`;
export const TELEGRAM_URL = `https://t.me/${OWNER.telegram.replace(/^@/, '')}`;
export const EMAIL_URL = `mailto:${OWNER.email}`;

export const PAYMENT_WARNING = `Only ever pay ${OWNER.name} directly, through the contacts above. Nobody else — including anyone else claiming to speak for this app — should ever be paid on its behalf.`;
