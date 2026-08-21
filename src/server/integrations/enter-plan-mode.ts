/**
 * EnterPlanMode context hook.
 *
 * Injects multi-document format guidance as additionalContext ONLY — no
 * permissionDecision, so the human's consent to enter plan mode is untouched.
 */

import { readStdinJson, finish } from './hook-io.js';

const GUIDANCE = `When the plan spans multiple documents (overview + sections), present it in the multi-document format:

# Overview / main plan
...root content...

<!--doc slug=implementation title="Implementation" parent=root-->
...
<!--doc slug=risks title="Risks" parent=root-->
...

Rules:
- Markers sit ALONE on their own line: <!--doc slug=<kebab-slug> title="Title" parent=<slug>-->
- Content before the first marker becomes the root document (titled from its H1).
- Exactly one root; parents must reference existing slugs; slugs are lowercase-kebab and unique.
- Cross-link documents with [[slug]] or [[slug|label]] or [label](doc:slug).
- Zero markers is fine — a single-document plan needs no markers.

The human reviews plans in a browser UI and can approve or request changes per section.`;

interface PreToolUseInput {
  tool_name?: string;
}

export async function runEnterPlanModeHook(): Promise<void> {
  const input = (await readStdinJson()) as PreToolUseInput;
  try {
    if (input?.tool_name !== 'EnterPlanMode') return finish({});
    return finish({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: GUIDANCE,
      },
    });
  } catch {
    return finish({});
  }
}
