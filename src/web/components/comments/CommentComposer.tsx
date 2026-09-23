import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, cx, inputClass } from '../primitives.js';

export interface ComposerState {
  /** Viewport position for the floating panel. */
  x: number;
  y: number;
  quote: string | null;
  line: number | null;
  lineEnd: number | null;
}

/**
 * Floating comment composer. Anchored near the selection (or centered for
 * general notes). Submits on Cmd/Ctrl+Enter; Esc cancels.
 */
export function CommentComposer({
  state,
  placeholder,
  submitLabel = 'Comment',
  onSubmit,
  onCancel,
}: {
  state: ComposerState;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Measured position; null until the panel has been laid out once. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canSubmit = body.trim().length > 0 && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(body.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment');
      setSubmitting(false);
    }
  };

  // Keep the panel inside the viewport by MEASURING it: the previous clamp used a
  // hardcoded 220px height and a 400px width, which clipped the panel off the left
  // edge on narrow windows and fit only by luck vertically (a two-line quote grows
  // the header). Re-clamped on resize too.
  useLayoutEffect(() => {
    const place = (): void => {
      const el = panelRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const pad = 12;
      setPos({
        x: Math.min(Math.max(pad, state.x), Math.max(pad, window.innerWidth - width - pad)),
        y: Math.min(Math.max(pad, state.y), Math.max(pad, window.innerHeight - height - pad)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [state.x, state.y, state.quote]);

  return (
    <div
      ref={panelRef}
      className="fixed z-40 w-[380px] max-w-[calc(100vw-1.5rem)] animate-pop rounded-xl border border-border bg-surface-1 shadow-pop"
      style={{ left: pos?.x ?? state.x, top: pos?.y ?? state.y, visibility: pos ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label="Add comment"
    >
      {state.quote && (
        <div className="border-b border-border px-3.5 py-2">
          <p className="line-clamp-2 text-[12px] italic leading-relaxed text-ink-muted">“{state.quote}”</p>
          {state.line != null && (
            <p className="mt-1 font-mono text-[10.5px] text-ink-faint">
              lines {state.line}
              {state.lineEnd != null && state.lineEnd !== state.line ? `–${state.lineEnd}` : ''}
            </p>
          )}
        </div>
      )}
      <div className="p-2.5">
        <textarea
          ref={ref}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
          }}
          rows={3}
          placeholder={placeholder ?? 'Leave a comment…'}
          className={cx(inputClass, 'resize-none leading-relaxed')}
        />
        {error && <p className="mt-1 px-1 text-[12px] text-danger">{error}</p>}
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-ink-faint">⌘⏎ to submit</span>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
              {submitLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
