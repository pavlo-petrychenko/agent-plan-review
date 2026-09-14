import type { Comment } from '../../../shared/types.js';
import { formatLineLabel } from '../../../shared/format.js';
import { cx } from '../primitives.js';
import { IconTrash } from '../icons.js';

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface CommentThreadProps {
  comments: Comment[];
  onDelete: (id: string) => void;
  /** Jump to the block this thread is anchored to. */
  onLocate?: () => void;
  compact?: boolean;
}

/** One anchored thread (comments sharing a line range), rendered inline. */
export function CommentThread({ comments, onDelete, onLocate, compact }: CommentThreadProps) {
  if (comments.length === 0) return null;
  return (
    <div className={cx('my-3 flex flex-col gap-2', compact && 'my-2')}>
      {comments.map((c) => (
        <CommentCard key={c.id} comment={c} onDelete={() => onDelete(c.id)} onLocate={onLocate} />
      ))}
    </div>
  );
}

export function CommentCard({
  comment,
  onDelete,
  onLocate,
  label,
}: {
  comment: Comment;
  onDelete: () => void;
  onLocate?: () => void;
  /** Extra context for diff-anchored comments (e.g. "removed in v9"). */
  label?: string;
}) {
  const anchored = comment.line != null;
  const anchorLabel = label ?? formatLineLabel(comment.line, comment.lineEnd);
  return (
    <div className="group rounded-xl border border-border bg-surface-1 shadow-card transition-colors hover:border-border-strong">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-[9.5px] font-bold text-accent">
          ME
        </span>
        <span className="text-[12px] font-medium text-ink">me</span>
        <span className="text-[11.5px] text-ink-faint">{timeLabel(comment.createdAt)}</span>
        {anchored && (
          <button
            onClick={onLocate}
            disabled={!onLocate}
            title="Jump to location"
            className={cx(
              'rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted transition-colors',
              onLocate && 'hover:bg-surface-3 hover:text-ink',
            )}
          >
            {anchorLabel}
          </button>
        )}
        <span className="flex-1" />
        <button
          onClick={onDelete}
          title="Delete comment"
          aria-label="Delete comment"
          className="rounded-md p-1 text-ink-faint opacity-0 transition-all hover:bg-danger-bg hover:text-danger group-hover:opacity-100"
        >
          <IconTrash className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="px-3.5 py-2.5">
        {comment.quote && (
          <blockquote className="mb-2 rounded-md bg-quote-bg px-3 py-1.5 text-[12.5px] italic leading-relaxed text-ink-muted">
            “{comment.quote}”
          </blockquote>
        )}
        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{comment.body}</p>
      </div>
    </div>
  );
}
