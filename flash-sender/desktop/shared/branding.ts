/**
 * The operator's own identity and contact details — shared between the
 * renderer and the main process so every surface (the UI, the installer,
 * the window title) shows the same information from one place.
 *
 * This is deliberately plain data, not a secret: it exists to be shown.
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

/**
 * Shown anywhere a user might be asked to pay, or might be contacted by
 * someone claiming to represent this app — the one line meant to stop a
 * copycat or an impersonator from getting paid instead of the real owner.
 */
export const PAYMENT_WARNING = `Only ever pay ${OWNER.name} directly, through the contacts above. Nobody else — including anyone else claiming to speak for this app — should ever be paid on its behalf.`;
