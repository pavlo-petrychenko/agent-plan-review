import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CommentDelivery } from '../../../shared/types.js';
import { Button, cx, inputClass } from '../primitives.js';

export interface ComposerState {
  /** Viewport position for the floating panel. */
  x: number;
  y: number;
  quote: string | null;
  line: number | null;
  lineEnd: number | null;
  boundaryTop?: number;
}

export interface CommentDeliveryUI {
  canAsk: boolean;
  reviewId?: string;
  decisionLabel: string;
  deliveryNote: string;
}

/**
 * Floating comment composer. Anchored near the selection (or centered for
 * general notes). Submits on Cmd/Ctrl+Enter; Esc cancels.
 */
export function CommentComposer({
  state,
  placeholder,
  deliveryUI,
  onSubmit,
  onCancel,
}: {
  state: ComposerState;
  placeholder?: string;
  deliveryUI: CommentDeliveryUI;
  onSubmit: (body: string, delivery: CommentDelivery) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const [submittingDelivery, setSubmittingDelivery] = useState<CommentDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const deliveryNoteId = useId();
  const errorId = useId();
  /** Measured position; null until the panel has been laid out once. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canSubmit = body.trim().length > 0 && submittingDelivery == null;

  const submit = async (delivery: CommentDelivery): Promise<void> => {
    if (!canSubmit) return;
    setSubmittingDelivery(delivery);
    setError(null);
    try {
      await onSubmit(body.trim(), delivery);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment');
      setSubmittingDelivery(null);
    }
  };

  // Keep the panel inside the viewport by MEASURING it: the previous clamp used a
  // hardcoded 220px height and a 400px width, which clipped the panel off the left
  // edge on narrow windows and fit only by luck vertically (a two-line quote grows
  // the header). Re-clamped on resize too.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const place = (): void => {
      const { width, height } = el.getBoundingClientRect();
      const pad = 12;
      const minY = Math.max(pad, state.boundaryTop ?? 0);
      const next = {
        x: Math.min(Math.max(pad, state.x), Math.max(pad, window.innerWidth - width - pad)),
        y: Math.min(Math.max(minY, state.y), Math.max(minY, window.innerHeight - height - pad)),
      };
      const current = posRef.current;
      if (current?.x === next.x && current.y === next.y) return;
      posRef.current = next;
      setPos(next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [
    state.x,
    state.y,
    state.quote,
    state.boundaryTop,
    deliveryUI.canAsk,
    deliveryUI.decisionLabel,
    deliveryUI.deliveryNote,
  ]);

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
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit('decision');
            }
          }}
          aria-describedby={
            [deliveryUI.deliveryNote ? deliveryNoteId : null, error ? errorId : null]
              .filter(Boolean)
              .join(' ') || undefined
          }
          aria-invalid={error != null}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          rows={3}
          placeholder={placeholder ?? 'Leave a comment…'}
          className={cx(inputClass, 'resize-none leading-relaxed')}
        />
        {deliveryUI.deliveryNote && (
          <p id={deliveryNoteId} className="mt-1.5 px-1 text-[11px] leading-relaxed text-ink-faint">
            {deliveryUI.deliveryNote}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="mt-1 px-1 text-[12px] text-danger">
            {error}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
          <span className="mr-auto text-[11px] text-ink-faint">⌘/Ctrl ↵ safe submit</span>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {deliveryUI.canAsk && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canSubmit}
              loading={submittingDelivery === 'ask'}
              onClick={() => void submit('ask')}
            >
              Ask agent
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={!canSubmit}
            loading={submittingDelivery === 'decision'}
            onClick={() => void submit('decision')}
          >
            {deliveryUI.decisionLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
