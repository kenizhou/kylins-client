// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Differences from velo: velo rebuilds raw MIME and stores the draft server-side
// via the provider on every save. Kylins persists the editable DraftInput to
// the local `local_drafts` table (local-first); raw MIME is only built at send
// time. The debounce (3s) and store-subscription shape are preserved verbatim.
//
// The save algorithm (debounce, staleness token, draftId write-back) lives in
// `draftAutoSaveEngine.ts`; this is the OS-compose-window policy: which store,
// which fields count as content, the isSaving/lastSavedAt flags, and the
// skip-empty-drafts gate. The state→DraftInput mapping is the SHARED
// `draftSessionToDraftInput` (features/composer/draftSession.ts) — before the
// unification this file's private mapper silently dropped classification,
// crypto flags, importance, receipts, deliverAt, preventCopy, and replyTo.

import { useComposerStore, type ComposerState } from '@/stores/composerStore';
import { useAccountStore } from '@/stores/accountStore';
import {
  draftSessionContentChanged,
  draftSessionToDraftInput,
} from '@/features/composer/draftSession';
import { createDraftAutoSave, type DraftAutoSaveHandle } from './draftAutoSaveEngine';

let handle: DraftAutoSaveHandle | null = null;

/** The empty-draft gate (preserved from the pre-engine implementation). */
function isBlank(s: ComposerState): boolean {
  return (
    !s.bodyHtml &&
    !s.subject &&
    s.to.length === 0 &&
    s.cc.length === 0 &&
    s.bcc.length === 0 &&
    s.replyTo.length === 0 &&
    s.attachments.length === 0
  );
}

/**
 * Start watching composerStore changes and auto-saving drafts (debounced).
 * Call `stopAutoSave` when the composer closes or the account changes.
 */
export function startAutoSave(accountId: string): void {
  stopAutoSave();

  handle = createDraftAutoSave<ComposerState>({
    subscribe: (listener) =>
      useComposerStore.subscribe((state, prev) =>
        listener(state.isOpen ? state : null, prev.isOpen ? prev : null),
      ),
    getSession: () => {
      const s = useComposerStore.getState();
      return s.isOpen ? s : null;
    },
    sessionToken: (s) => s.stagingDraftId,
    shouldSave: (s) => {
      // The account must still exist (guards against mid-save account removal).
      if (isBlank(s)) return false;
      return useAccountStore.getState().accounts.some((a) => a.id === accountId);
    },
    contentChanged: (a, b) =>
      draftSessionContentChanged({ ...a, intent: a.mode }, { ...b, intent: b.mode }),
    // The account id is captured at start time to avoid a mismatch if the
    // user switches accounts during the debounce window. The window's `mode`
    // maps to the persisted `intent` (base family — no with-attachments
    // variants on this surface).
    toInput: (s) => draftSessionToDraftInput({ ...s, intent: s.mode }, accountId),
    draftId: (s) => s.draftId,
    onSaved: (s, id) => {
      if (id !== s.draftId) s.setDraftId(id);
      s.setLastSavedAt(Date.now());
    },
    onError: (err) => console.error('Failed to auto-save draft:', err),
    onSaveStart: (s) => s.setIsSaving(true),
    onSettled: () => useComposerStore.getState().setIsSaving(false),
  });
  handle.start();
}

/**
 * Stop auto-saving and clean up the subscription + pending timer.
 */
export function stopAutoSave(): void {
  handle?.stop();
  handle = null;
}

/**
 * Immediately persist the current draft, cancelling any pending debounced
 * save. Used by the pop-out window's close confirmation ("Save Draft").
 * Safe to call when auto-save was never started (flush no-ops).
 */
export async function flushDraftSave(): Promise<void> {
  if (!handle) return;
  const ok = await handle.flush();
  if (!ok) {
    throw new Error('Draft save failed');
  }
}
