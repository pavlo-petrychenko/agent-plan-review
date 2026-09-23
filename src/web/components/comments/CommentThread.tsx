import { useState } from 'react';
import type { Comment, CommentThreadView } from '../../../shared/types.js';
import { formatLineLabel } from '../../../shared/format.js';
import { Button, cx, inputClass } from '../primitives.js';
import { IconCheck, IconTrash } from '../icons.js';

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface CommentThreadProps {
  thread: CommentThreadView;
  onDelete: (id: string) => void;
  /** Post a human reply into the thread. */
  onReply: (rootId: string, body: string) => Promise<void>;
  /** Resolve/unresolve a thread (root only). */
  onResolve: (rootId: string, resolved: boolean) => void;
  /** Jump to the block this thread is anchored to. */
  onLocate?: () => void;
  /** Extra context for diff-anchored comments (e.g. "removed in v9"). */
  label?: string;
  compact?: boolean;
}

/** One comment thread: root, its replies, a reply box and a resolve control. */
export function CommentThread({
  thread,
  onDelete,
  onReply,
  onResolve,
  onLocate,
  label,
  compact,
}: CommentThreadProps) {
  const { root, replies } = thread;
  const resolved = root.resolved === true;
  return (
    <div className={cx('my-3 flex flex-col gap-2', compact && 'my-2')}>
      <CommentCard
        comment={root}
        isRoot
        onDelete={() => onDelete(root.id)}
        onLocate={onLocate}
        label={label}
        resolved={resolved}
        onResolve={() => onResolve(root.id, !resolved)}
      />
      {replies.length > 0 && (
        <div className="ml-4 flex flex-col gap-2 border-l-2 border-border pl-3">
          {replies.map((r) => (
            <CommentCard key={r.id} comment={r} onDelete={() => onDelete(r.id)} />
          ))}
        </div>
      )}
      {resolved ? (
        <span className="self-start px-1.5 text-[11.5px] text-ink-faint">Reopen the thread to reply</span>
      ) : (
        <ReplyBox onReply={(body) => onReply(root.id, body)} />
      )}
    </div>
  );
}

/** Collapsed "Reply…" affordance that expands into a small composer. */
function ReplyBox({ onReply }: { onReply: (body: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await onReply(body.trim());
      setBody('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="self-start rounded-md px-1.5 py-0.5 text-[12px] text-ink-faint transition-colors hover:bg-surface-2 hover:text-accent"
      >
        Reply…
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        autoFocus
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
          if (e.key === 'Escape') {
            setOpen(false);
            setBody('');
          }
        }}
        placeholder="Reply…"
        className={cx(inputClass, 'resize-none leading-relaxed')}
      />
      <div className="flex justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setBody('');
          }}
        >
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!body.trim()} loading={busy} onClick={() => void submit()}>
          Reply
        </Button>
      </div>
    </div>
  );
}

export function CommentCard({
  comment,
  isRoot = false,
  onDelete,
  onLocate,
  label,
  onResolve,
  resolved,
}: {
  comment: Comment;
  /**
   * Threads render their anchor ONCE, on the root: a reply inherits the root's
   * anchor, so repeating the quote and the line chip on every card duplicated
   * the context and made the two chips disagree (`removed in v1` vs `line 20`).
   */
  isRoot?: boolean;
  onDelete: () => void;
  onLocate?: () => void;
  /** Extra context for diff-anchored comments (e.g. "removed in v9"). */
  label?: string;
  /** Present only on a thread root — renders the resolve toggle. */
  onResolve?: () => void;
  resolved?: boolean;
}) {
  const anchored = isRoot && comment.line != null;
  const anchorLabel = label ?? formatLineLabel(comment.line, comment.lineEnd);
  const agent = comment.author === 'agent';
  return (
    <div
      className={cx(
        'group rounded-xl border border-border bg-surface-1 shadow-card transition-colors hover:border-border-strong',
        resolved && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
        <span
          className={cx(
            'flex h-5 w-5 items-center justify-center rounded-full text-[9.5px] font-bold',
            agent ? 'bg-accent text-accent-ink' : 'bg-accent-soft text-accent',
          )}
        >
          {agent ? 'AI' : 'ME'}
        </span>
        <span className="text-[12px] font-medium text-ink">{agent ? 'Claude' : 'me'}</span>
        <span className="text-[11.5px] text-ink-faint">{timeLabel(comment.createdAt)}</span>
        {anchored &&
          (onLocate ? (
            <button
              onClick={onLocate}
              title="Jump to location"
              className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
            >
              {anchorLabel}
            </button>
          ) : (
            // No navigation available (diff threads): a label, not a dead button
            // that promises a jump.
            <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted">
              {anchorLabel}
            </span>
          ))}
        <span className="flex-1" />
        {onResolve && (
          <button
            onClick={onResolve}
            title={resolved ? 'Reopen thread' : 'Mark thread resolved'}
            className={cx(
              'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium transition-colors',
              resolved
                ? 'bg-ok-bg text-ok hover:bg-surface-2'
                : 'text-ink-faint hover:bg-surface-2 hover:text-ok',
            )}
          >
            <IconCheck className="h-3 w-3" />
            {resolved ? 'Resolved' : 'Resolve'}
          </button>
        )}
        <button
          onClick={onDelete}
          title="Delete comment"
          aria-label="Delete comment"
          className="rounded-md p-1 text-ink-faint opacity-0 transition-all hover:bg-danger-bg hover:text-danger focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent group-hover:opacity-100"
        >
          <IconTrash className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="px-3.5 py-2.5">
        {isRoot && comment.quote && (
          <blockquote className="mb-2 rounded-md bg-quote-bg px-3 py-1.5 text-[12.5px] italic leading-relaxed text-ink-muted">
            “{comment.quote}”
          </blockquote>
        )}
        {comment.html != null ? (
          // Markdown, rendered server-side without raw HTML (comment bodies are
          // authored by an agent as often as by the human).
          <div className="md-comment" dangerouslySetInnerHTML={{ __html: comment.html }} />
        ) : (
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{comment.body}</p>
        )}
      </div>
    </div>
  );
}
