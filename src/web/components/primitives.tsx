/** Reusable UI primitives — buttons, pills, selects, fields, modal, empty states. */

import { useEffect, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { IconSpinner, IconX } from './icons.js';

// ---------------------------------------------------------------------------
// cx helper
// ---------------------------------------------------------------------------

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink hover:bg-accent-hover shadow-sm font-medium disabled:opacity-40',
  secondary:
    'bg-surface-2 text-ink border border-border hover:border-border-strong hover:bg-surface-3 font-medium',
  ghost: 'text-ink-muted hover:text-ink hover:bg-surface-2',
  danger: 'bg-danger text-danger-ink hover:bg-danger-hover shadow-sm font-medium disabled:opacity-40',
  success: 'bg-ok text-ok-ink hover:brightness-110 shadow-sm font-medium disabled:opacity-40',
};

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg transition-all duration-150 select-none',
        'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1',
        'disabled:pointer-events-none',
        size === 'sm' ? 'px-2.5 py-1.5 text-[12.5px]' : 'px-3.5 py-2 text-[13.5px]',
        VARIANTS[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <IconSpinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Pill
// ---------------------------------------------------------------------------

type PillTone = 'neutral' | 'accent' | 'pending' | 'ok' | 'danger';

export function Pill({ tone = 'neutral', className, children }: { tone?: PillTone; className?: string; children: ReactNode }) {
  const tones: Record<PillTone, string> = {
    neutral: 'bg-surface-2 text-ink-muted border-border',
    accent: 'bg-accent-soft text-accent border-transparent',
    pending: 'bg-pending-bg text-pending border-transparent',
    ok: 'bg-ok-bg text-ok border-transparent',
    danger: 'bg-danger-bg text-danger border-transparent',
  };
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'sm' | 'md';
}

export function Select({ size = 'md', className, children, ...rest }: SelectProps) {
  return (
    <select
      className={cx(
        'appearance-none rounded-lg border border-border bg-surface-1 text-ink transition-colors',
        'hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent cursor-pointer',
        'bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23888%27 stroke-width=%272.4%27 stroke-linecap=%27round%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")] bg-[position:right_0.6rem_center] bg-no-repeat pr-7',
        size === 'sm' ? 'py-1 pl-2 text-[12.5px]' : 'py-1.5 pl-2.5 text-[13px]',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Field / inputs
// ---------------------------------------------------------------------------

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-faint transition-colors focus-visible:outline-2 focus-visible:outline-accent hover:border-border-strong';

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  wide,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh]">
      <div className="fixed inset-0 animate-fade-in bg-black/45 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal
        className={cx(
          'relative z-10 w-full animate-rise rounded-2xl border border-border bg-surface-1 shadow-pop',
          wide ? 'max-w-3xl' : 'max-w-lg',
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Close"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Empty state / spinner
// ---------------------------------------------------------------------------

export function EmptyState({ icon, title, body }: { icon?: ReactNode; title: string; body?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-ink-faint">{icon}</div>}
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {body && <p className="max-w-md text-[13.5px] leading-relaxed text-ink-muted">{body}</p>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-14 text-ink-faint">
      <IconSpinner className="h-4 w-4" />
      {label && <span className="text-[13px]">{label}</span>}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mx-auto my-6 max-w-lg rounded-xl border border-danger/30 bg-danger-bg px-4 py-3 text-center">
      <p className="text-[13px] text-danger">{message}</p>
      {onRetry && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
