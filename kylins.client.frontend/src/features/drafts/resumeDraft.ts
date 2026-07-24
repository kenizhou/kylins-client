// Single-click resume choreography for Drafts-folder rows.
//
// Clicking a draft row resumes it into the docked inline composer and points
// the reading pane at the right target:
//   - thread-linked drafts anchor to the thread's latest message (the
//     canonical selectThread pipeline runs so the reading pane, selection,
//     and thread-scoped actions all stay consistent),
//   - new-message drafts anchor standalone — the draft row itself is the
//     target (viewStore.selectedDraftId).
//
// Ordering is deliberate: the anchor message is resolved first (no side
// effects), then the store-level resumeDraft runs its confirm/replace
// policy, and selection is updated ONLY when the session actually owns the
// draft afterwards — a declined confirm must never move the list highlight
// away from the session still showing in the dock.

import type { DbDraft } from '@/services/composer/drafts';
import type { MailMessage } from '@/features/view/viewStore';
import { getMessagesForThread, mapMessageToMailMessage } from '@/services/db/threads';
import { getMessageBody } from '@/services/db/messageBodies';
import { useInlineComposerStore } from '@/stores/inlineComposerStore';
import { useThreadStore } from '@/stores/threadStore';
import { useViewStore } from '@/features/view/viewStore';

export type DraftAccountInfo = { id: string; email: string; displayName?: string | null };

/** Monotonic resume token: rapid clicks on different draft rows race the
 *  async anchor resolution — without this, a slow resolution for draft A can
 *  land AFTER draft B's session exists and clobber it (and the selection).
 *  Latest click wins; stale resolutions bail before any side effect. */
let resumeSeq = 0;

/** Resolve the thread's latest message as the reply anchor (best-effort). */
async function resolveAnchorMessage(draft: DbDraft): Promise<MailMessage | null> {
  if (!draft.thread_id) return null;
  try {
    const msgs = await getMessagesForThread(draft.account_id, draft.thread_id);
    const latest = msgs.at(-1);
    if (!latest) return null;
    const body = await getMessageBody(draft.account_id, latest.id);
    return mapMessageToMailMessage(latest, body?.bodyHtml ?? null);
  } catch (e) {
    console.error('[drafts] anchor message resolution failed', e);
    return null;
  }
}

/**
 * Resume a saved draft into the docked inline composer (single-click on a
 * Drafts-folder row). Conflict policy lives in `resumeDraft`: same draft →
 * focus no-op; a different non-pristine session confirms before replacement.
 */
export async function resumeDraftInline(draft: DbDraft, account: DraftAccountInfo): Promise<void> {
  const seq = ++resumeSeq;
  const message = await resolveAnchorMessage(draft);
  // A newer click superseded this one while the anchor resolved.
  if (seq !== resumeSeq) return;

  await useInlineComposerStore.getState().resumeDraft(draft, account, { message });

  // Abort check: the resume is only honored if the dock session actually owns
  // this draft now (a same-draft focus no-op also passes — it already owns it).
  const session = useInlineComposerStore.getState().session;
  if (session?.draftId !== draft.id) return;

  if (message) {
    // Prefer the canonical pipeline when the thread is loaded (fresh body /
    // crypto state + thread selection in one path); otherwise set the
    // resolved message directly.
    const thread = useThreadStore.getState().threads.find((t) => t.id === draft.thread_id);
    if (thread) {
      await useThreadStore.getState().selectThread(thread);
    } else {
      useViewStore.getState().setSelectedMessage(message);
    }
  } else {
    useViewStore.getState().setSelectedDraft(draft.id);
  }
}
