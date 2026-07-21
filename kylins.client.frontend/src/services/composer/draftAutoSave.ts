// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Differences from velo: velo rebuilds raw MIME and stores the draft server-side
// via the provider on every save. Kylins persists the editable DraftInput to
// the local `local_drafts` table (local-first); raw MIME is only built at send
// time. The debounce (3s) and store-subscription shape are preserved verbatim.

import { useComposerStore } from '@/stores/composerStore';
import { useAccountStore } from '@/stores/accountStore';
import { saveDraft, type DraftInput, type StoredAttachment } from './drafts';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let currentAccountId: string | null = null;

const DEBOUNCE_MS = 3000;

function composerStateToDraftInput(
  state: ReturnType<typeof useComposerStore.getState>,
  accountId: string,
): DraftInput {
  // Persist path-backed attachment refs (T7b). The staged file lives under
  // `<appData>/outbox-attachments/{stagingDraftId}/` and remains valid across
  // app restarts, so a restored draft's `filePath` still points at real bytes.
  const attachments: StoredAttachment[] = state.attachments.map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    filePath: a.filePath,
    size: a.size,
  }));

  return {
    accountId,
    to: state.to,
    cc: state.cc,
    bcc: state.bcc,
    subject: state.subject,
    bodyHtml: state.bodyHtml,
    fromEmail: state.fromEmail,
    threadId: state.threadId,
    inReplyToMessageId: state.inReplyToMessageId,
    signatureId: state.signatureId,
    attachments,
  };
}

async function saveDraftNow(): Promise<boolean> {
  const state = useComposerStore.getState();
  // Capture the accountId at save time to avoid a mismatch if the user switches
  // accounts during the debounce window.
  const accountId = currentAccountId;
  if (!state.isOpen || !accountId) return true;

  const account = useAccountStore.getState().accounts.find((a) => a.id === accountId);
  if (!account) return true;

  // Don't save empty drafts.
  if (
    !state.bodyHtml &&
    !state.subject &&
    state.to.length === 0 &&
    state.cc.length === 0 &&
    state.bcc.length === 0 &&
    state.replyTo.length === 0 &&
    state.attachments.length === 0
  )
    return true;

  state.setIsSaving(true);

  try {
    const input = composerStateToDraftInput(state, accountId);
    const id = await saveDraft(input, state.draftId);
    if (id !== state.draftId) {
      state.setDraftId(id);
    }
    state.setLastSavedAt(Date.now());
    return true;
  } catch (err) {
    console.error('Failed to auto-save draft:', err);
    return false;
  } finally {
    state.setIsSaving(false);
  }
}

function scheduleSave(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(saveDraftNow, DEBOUNCE_MS);
}

/**
 * Start watching composerStore changes and auto-saving drafts (debounced).
 * Call `stopAutoSave` when the composer closes or the account changes.
 */
export function startAutoSave(accountId: string): void {
  stopAutoSave();
  currentAccountId = accountId;

  unsubscribe = useComposerStore.subscribe((state, prevState) => {
    if (!state.isOpen) return;
    // Only save when content-relevant fields change.
    if (
      state.bodyHtml !== prevState.bodyHtml ||
      state.subject !== prevState.subject ||
      state.to !== prevState.to ||
      state.cc !== prevState.cc ||
      state.bcc !== prevState.bcc ||
      state.attachments !== prevState.attachments
    ) {
      scheduleSave();
    }
  });
}

/**
 * Stop auto-saving and clean up the subscription + pending timer.
 */
export function stopAutoSave(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  currentAccountId = null;
}

/**
 * Immediately persist the current draft, cancelling any pending debounced
 * save. Used by the pop-out window's close confirmation ("Save Draft").
 * Safe to call when auto-save was never started (saveDraftNow no-ops).
 */
export async function flushDraftSave(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const ok = await saveDraftNow();
  if (!ok) {
    throw new Error('Draft save failed');
  }
}
