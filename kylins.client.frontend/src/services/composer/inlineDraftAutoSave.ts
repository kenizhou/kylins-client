// Debounced local persistence for the docked inline composer (reply / forward
// in the reading pane). Policy wrapper over `draftAutoSaveEngine.ts` (the
// shared debounce/staleness/write-back algorithm) with the dock's rules:
//   - only NON-pristine sessions save (a reply opened and abandoned without
//     edits leaves no row — otherwise every reply click would clutter the
//     Drafts folder),
//   - the seed must have resolved (a mid-seed save would persist an empty
//     shell),
//   - the draftId write-back must not re-arm the debounce (excluded from
//     contentChanged).
// The persisted row survives an app reload: it appears in the Drafts folder
// and its conversation row keeps the [Draft] chip (via draftIndexStore). The
// store's lifecycle paths (send / discard / pop-out / replace) delete the
// row; this module only writes it.

import {
  anchorMessage,
  useInlineComposerStore,
  type InlineSession,
} from '@/stores/inlineComposerStore';
import {
  draftSessionContentChanged,
  draftSessionToDraftInput,
} from '@/features/composer/draftSession';
import { createDraftAutoSave, type DraftAutoSaveHandle } from './draftAutoSaveEngine';

let handle: DraftAutoSaveHandle | null = null;

/**
 * Start watching inlineComposerStore for dirty sessions. Idempotent. Wired
 * once from the main window's startup (the inline composer only exists
 * there); it no-ops whenever no session is active.
 */
export function startInlineDraftAutoSave(): void {
  stopInlineDraftAutoSave();
  handle = createDraftAutoSave<InlineSession>({
    subscribe: (listener) =>
      useInlineComposerStore.subscribe((state, prev) => listener(state.session, prev.session)),
    getSession: () => useInlineComposerStore.getState().session,
    sessionToken: (s) => s.stagingDraftId,
    shouldSave: (s) => !s.pristine && s.seed !== null,
    contentChanged: draftSessionContentChanged,
    toInput: (s) =>
      draftSessionToDraftInput(
        {
          ...s,
          // threadId falls back to the replied-to message's conversation
          // (null for standalone new-message drafts); the original-message
          // reference comes from the anchor.
          threadId: s.threadId ?? anchorMessage(s)?.threadId ?? null,
          originalMessageId: anchorMessage(s)?.messageId ?? null,
        },
        s.accountId,
      ),
    draftId: (s) => s.draftId,
    onSaved: (s, id) => {
      if (s.draftId !== id) {
        useInlineComposerStore.setState({ session: { ...s, draftId: id } });
      }
    },
    onError: (err) => console.error('[inline-draft-autosave] save failed:', err),
  });
  handle.start();
}

/** Stop watching and cancel any pending debounced save. */
export function stopInlineDraftAutoSave(): void {
  handle?.stop();
  handle = null;
}

/**
 * Immediately persist the current session, cancelling any pending debounce.
 * Used by the replace paths (open / resumeDraft) before swapping sessions so
 * the OUTGOING draft is preserved complete — its row stays in the Drafts
 * folder and its conversation keeps the [Draft] chip (Outlook/Gmail
 * semantics: starting another reply must never delete the previous draft).
 * No-op when autosave was never started or the gate fails.
 */
export async function flushInlineDraftSave(): Promise<void> {
  await handle?.flush();
}
