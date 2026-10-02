import { useState } from 'react';
import type { Review } from '../../../shared/types.js';
import { Button, Modal, Pill, cx } from '../primitives.js';
import { IconCheck, IconX } from '../icons.js';

export interface ReviewBarProps {
  review: Review | undefined;
  projectKey: string | null;
  /** Version currently being viewed. */
  viewingVersion: number;
  /** Open threads the compiler would send (one entry per thread). */
  threadCount: number;
  onApprove: () => Promise<void>;
  onReject: (summary?: string) => Promise<void>;
}

/**
 * The decision surface. Buttons appear only while the review is pending AND
 * the human is viewing the exact version under review; the resolved pill
 * remains afterwards as the record.
 */
export function ReviewBar({
  review,
  projectKey,
  viewingVersion,
  threadCount,
  onApprove,
  onReject,
}: ReviewBarProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  if (!review) return null;

  const pending = review.status === 'pending';
  const onReviewedVersion = review.projectKey === projectKey && review.version === viewingVersion;

  return (
    <>
      <div
        className={cx(
          'flex flex-wrap items-center gap-2.5 border-b px-5 py-2.5 max-md:px-3',
          pending ? 'border-pending/25 bg-pending-bg/60' : 'border-border bg-surface-0',
        )}
      >
        {pending && !onReviewedVersion ? (
          <Pill tone="pending">
            <span className="mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-pending" />
            review pending on v{review.version}
          </Pill>
        ) : pending ? (
          <Pill tone="pending">
            <span className="mr-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-pending" />
            review pending
          </Pill>
        ) : review.status === 'approved' ? (
          <Pill tone="ok">
            <IconCheck className="h-3 w-3" /> approved
          </Pill>
        ) : (
          <Pill tone="danger">
            <IconX className="h-3 w-3" /> changes requested
          </Pill>
        )}

        {pending && (
          <span
            className={cx(
              'min-h-4 text-[12px]',
              threadCount > 0 ? 'text-ink-muted' : 'invisible',
            )}
          >
            {threadCount > 0
              ? `${threadCount} open thread${threadCount === 1 ? '' : 's'} will be included with your decision. Resolve a thread to exclude it.`
              : 'No open threads'}
          </span>
        )}

        <span className="flex-1" />

        {pending && onReviewedVersion && (
          <div className="flex items-center gap-2">
            <Button
              variant="success"
              size="sm"
              loading={busy === 'approve'}
              disabled={busy !== null}
              onClick={async () => {
                setBusy('approve');
                try {
                  await onApprove();
                } finally {
                  setBusy(null);
                }
              }}
            >
              <IconCheck className="h-3.5 w-3.5" />
              Approve
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busy === 'reject'}
              disabled={busy !== null}
              onClick={() => setRejectOpen(true)}
            >
              Request changes…
            </Button>
          </div>
        )}
      </div>

      <RejectModal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={async (summary) => {
          setBusy('reject');
          try {
            await onReject(summary);
            setRejectOpen(false);
          } finally {
            setBusy(null);
          }
        }}
      />
    </>
  );
}

function RejectModal({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (summary?: string) => Promise<void>;
}) {
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);

  return (
    <Modal open={open} onClose={onClose} title="Request changes">
      <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
        Unresolved threads are included in the feedback the agent receives; resolved threads and agent replies
        are not. The summary below is attached only to this decision.
      </p>
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        rows={3}
        autoFocus
        placeholder="Optional summary — e.g. “Focus on the migration strategy”"
        className="w-full resize-none rounded-lg border border-border bg-surface-1 px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-accent"
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          loading={submitting}
          onClick={async () => {
            setSubmitting(true);
            try {
              await onConfirm(summary.trim() || undefined);
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Send changes to agent
        </Button>
      </div>
    </Modal>
  );
}
