import React from 'react';
import type { TxState } from '../../shared/types';
import { TX_STATES } from '../lib/format';
import { bridge } from '../lib/bridge';

/** Small building blocks shared across pages. */

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      {(title || action) && (
        <header className="card__header">
          {title && <h2 className="card__title">{title}</h2>}
          {action}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function Row({
  label,
  value,
  mono,
  emphasis,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className={`row${emphasis ? ' row--emphasis' : ''}`}>
      <span className="row__label">{label}</span>
      <span className={`row__value${mono ? ' row__value--mono' : ''}`}>{value}</span>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label">
        <span>{label}</span>
        {hint && <span className="field__hint">{hint}</span>}
      </label>
      {children}
      {error && (
        <div className="field__error" role="alert">
          <span aria-hidden>⚠</span>
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children: React.ReactNode;
}) {
  const icon = { info: 'ℹ', warning: '⚠', danger: '✕', success: '✓' }[tone];

  return (
    <div className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="alert__icon" aria-hidden>
        {icon}
      </span>
      <div className="alert__body">
        {title && <div className="alert__title">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
  pulse,
}: {
  tone?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  children: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className={`badge badge--${tone}`}>
      <span className={`dot${pulse ? ' dot--pulse' : ''}`} aria-hidden />
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: TxState }) {
  const state = TX_STATES[status];
  return (
    <Badge tone={state.tone} pulse={state.active}>
      {state.label}
    </Badge>
  );
}

export function Button({
  variant = 'default',
  size,
  loading,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'secondary' | 'ghost' | 'danger' | 'send';
  size?: 'sm';
  loading?: boolean;
}) {
  const classes = [
    'btn',
    variant !== 'default' && `btn--${variant}`,
    variant === 'send' && 'btn--primary',
    size && `btn--${size}`,
    rest.className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button {...rest} className={classes} disabled={rest.disabled || loading}>
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  footer,
  wide,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  // Escape closes; the backdrop does not, so a stray click cannot dismiss a
  // confirmation dialog the user is mid-way through reading.
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`modal${wide ? ' modal--wide' : ''}`}>
        <header className="modal__header">
          <h2 className="modal__title">{title}</h2>
          {subtitle && <p className="modal__subtitle">{subtitle}</p>}
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden>
        {icon}
      </div>
      <div style={{ fontWeight: 600, color: 'var(--text-muted)' }}>{title}</div>
      {hint && <div style={{ marginTop: 4, fontSize: 13 }}>{hint}</div>}
    </div>
  );
}

/** Opens an explorer link in the user's real browser, via the validated IPC path. */
export function ExplorerLink({ url, children }: { url: string | null; children?: React.ReactNode }) {
  if (!url) return <span className="faint">—</span>;

  return (
    <button
      type="button"
      className="link"
      onClick={(event) => {
        event.stopPropagation();
        void bridge.shell.openExternal(url);
      }}
    >
      {children ?? 'View on Explorer'} →
    </button>
  );
}

/** Copy-to-clipboard affordance for addresses and hashes. */
export function Copyable({ value, display }: { value: string; display?: React.ReactNode }) {
  const [copied, setCopied] = React.useState(false);

  return (
    <button
      type="button"
      className="link mono"
      style={{ fontWeight: 500 }}
      title={`${value} — click to copy`}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? '✓ copied' : (display ?? value)}
    </button>
  );
}
