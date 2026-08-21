import { useState } from 'react';
import type { GistBinding } from '../../../shared/types.js';
import { useApi } from '../../api/cache.js';
import { endpoints, keys } from '../../api/endpoints.js';
import { Button, Field, Modal, Pill, Spinner, cx, inputClass } from '../primitives.js';
import { IconCheck, IconCopy, IconExternal, IconGist } from '../icons.js';
import { useToast } from '../../state/toasts.js';

export interface GistDialogProps {
  open: boolean;
  onClose: () => void;
  projectKey: string;
  projectName: string;
  version: number;
  onSaved: (binding: GistBinding) => void;
}

/**
 * Push the current version's markdown to the project's single gist
 * destination. Create-vs-overwrite is unmistakable; readiness is checked and
 * surfaced with exact remediation before saving is allowed.
 */
export function GistDialog({ open, onClose, projectKey, projectName, version, onSaved }: GistDialogProps) {
  const { toast } = useToast();
  const channels = useApi(open ? keys.channels : null, endpoints.getChannels);
  const storage = useApi(open ? keys.storage(projectKey) : null, () => endpoints.getStorage(projectKey));

  const binding = storage.data?.gist ?? undefined;
  const [description, setDescription] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; fixCommand?: string } | null>(null);

  const gist = channels.data?.find((c) => c.id === 'gist');
  const descValue = description ?? binding?.description ?? `${projectName} — plan`;
  const fileValue = filename ?? binding?.filename ?? 'plan.md';

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await endpoints.saveToGist(projectKey, version, descValue, fileValue);
      toast(result.created ? `Saved v${version} → new secret gist` : `Updated gist with v${version}`, 'success');
      onSaved(result);
      onClose();
    } catch (err) {
      const payload = (err as { payload?: { fixCommand?: string } }).payload;
      setSaveError({
        message: err instanceof Error ? err.message : 'Save failed',
        fixCommand: payload?.fixCommand,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Save to GitHub Gist">
      <div className="flex flex-col gap-4">
        {/* current binding */}
        {binding && (
          <div className="rounded-xl border border-border bg-surface-2 px-3.5 py-3">
            <div className="flex items-center gap-2 text-[12.5px]">
              <IconGist className="h-3.5 w-3.5 text-ink-muted" />
              <span className="font-medium">Existing destination</span>
              <Pill tone="neutral">holds v{binding.savedVersion}</Pill>
              <a
                href={binding.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
              >
                Open gist <IconExternal className="h-3 w-3" />
              </a>
            </div>
          </div>
        )}

        {/* readiness */}
        {channels.loading && !gist ? (
          <Spinner label="Checking gh CLI…" />
        ) : gist && !gist.ready ? (
          <div className="rounded-xl border border-pending/30 bg-pending-bg px-3.5 py-3">
            <p className="text-[13px] font-medium text-pending">{gist.reason}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {gist.fixCommand && <FixCommand command={gist.fixCommand} />}
              {gist.fixUrl && (
                <a href={gist.fixUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
                  Install instructions <IconExternal className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
        ) : gist?.ready ? (
          <div className="flex items-center gap-2 rounded-xl border border-ok/25 bg-ok-bg px-3.5 py-2.5 text-[12.5px] text-ok">
            <IconCheck className="h-3.5 w-3.5" /> gh CLI ready — authenticated with gist scope
          </div>
        ) : null}

        {/* mode copy */}
        <p className="text-[13px] leading-relaxed text-ink-muted">
          {binding ? (
            <>
              Saving will <strong className="text-ink">overwrite the existing gist</strong> in place — GitHub keeps its own
              revision history.
            </>
          ) : (
            <>
              This will <strong className="text-ink">create a new secret gist</strong> for this project. Later saves update
              the same gist.
            </>
          )}
        </p>

        <Field label="Description">
          <input className={inputClass} value={descValue} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Filename">
          <input className={cx(inputClass, 'font-mono')} value={fileValue} onChange={(e) => setFilename(e.target.value)} />
        </Field>

        {saveError && (
          <div className="rounded-xl border border-danger/30 bg-danger-bg px-3.5 py-3">
            <p className="text-[13px] text-danger">{saveError.message}</p>
            {saveError.fixCommand && (
              <div className="mt-2">
                <FixCommand command={saveError.fixCommand} />
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!gist?.ready || saving} loading={saving} onClick={() => void save()}>
            <IconGist className="h-4 w-4" />
            {binding ? `Update gist with v${version}` : `Save v${version} → gist`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function FixCommand({ command }: { command: string }) {
  const { toast } = useToast();
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(command).then(
          () => toast('Copied to clipboard', 'success'),
          () => toast('Could not copy', 'error'),
        );
      }}
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-1 px-2.5 py-1.5 font-mono text-[12px] text-ink transition-colors hover:border-border-strong"
      title="Copy to clipboard"
    >
      <span>$ {command}</span>
      <IconCopy className="h-3 w-3 text-ink-faint" />
    </button>
  );
}
