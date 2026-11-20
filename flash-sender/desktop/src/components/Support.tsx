import { OWNER, WHATSAPP_URL, TELEGRAM_URL, EMAIL_URL, PAYMENT_WARNING } from '../../shared/branding';

/**
 * Always visible, in every app state — the loading screen, every page, any
 * error — so there is never a moment where this app is on screen without
 * saying who it belongs to and how to reach them.
 */
export function SupportFooter({ compact }: { compact?: boolean }) {
  return (
    <footer className={`support-footer${compact ? ' support-footer--compact' : ''}`}>
      <div className="support-footer__owner">
        Flash Sender by <strong>{OWNER.name}</strong>
      </div>
      <div className="support-footer__links">
        <a href={WHATSAPP_URL} target="_blank" rel="noreferrer" className="link">
          WhatsApp
        </a>
        <a href={TELEGRAM_URL} target="_blank" rel="noreferrer" className="link">
          Telegram {OWNER.telegram}
        </a>
        <a href={EMAIL_URL} className="link">
          {OWNER.email}
        </a>
      </div>
      {!compact && <div className="support-footer__warning">{PAYMENT_WARNING}</div>}
    </footer>
  );
}
