// Shared debounced draft saver for both compose surfaces.
//
// The dock (inlineDraftAutoSave) and the OS compose window (draftAutoSave)
// implement the same algorithm: subscribe → content-changed gate → debounce →
// saveDraft → write the row id back with a staleness token so a slow save can
// never clobber a newer session. This engine is the algorithm once; each
// surface supplies its policy as a thin wrapper.

import { deleteDraft, saveDraft, type DraftInput } from './drafts';

export interface DraftAutoSavePolicy<TSession> {
  /** Subscribe to session changes (zustand subscribe shape). */
  subscribe: (listener: (next: TSession | null, prev: TSession | null) => void) => () => void;
  /** Current session (null = nothing to save). */
  getSession: () => TSession | null;
  /** Staleness token: a save in flight writes its row id back ONLY when the
   *  live session's token still matches. */
  sessionToken: (s: TSession) => string;
  /** Gate (e.g. non-pristine for the dock, non-empty for the window). */
  shouldSave: (s: TSession) => boolean;
  /** True when the change between prev/next should schedule a save. The
   *  draftId write-back must NOT count (it would re-arm the debounce every
   *  3s for the session's lifetime). */
  contentChanged: (prev: TSession, next: TSession) => boolean;
  toInput: (s: TSession) => DraftInput;
  draftId: (s: TSession) => string | null;
  /** Row id write-back after a successful save (still-current session). */
  onSaved: (s: TSession, id: string) => void;
  onError?: (err: unknown) => void;
  /** Fires before each save attempt (e.g. isSaving flags). */
  onSaveStart?: (s: TSession) => void;
  /** Fires in `finally` after each save attempt (success, error, or
   *  superseded-session) — flags must be cleared here, not in onSaved. */
  onSettled?: () => void;
}

export interface DraftAutoSaveHandle {
  /** Idempotent. */
  start: () => void;
  stop: () => void;
  /** Cancel any pending debounce and save immediately. Resolves false when
   *  the save failed (mirrors the window's flushDraftSave contract). */
  flush: () => Promise<boolean>;
}

const DEBOUNCE_MS = 3000;

export function createDraftAutoSave<TSession>(
  policy: DraftAutoSavePolicy<TSession>,
): DraftAutoSaveHandle {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  async function saveNow(): Promise<boolean> {
    const s = policy.getSession();
    if (!s || !policy.shouldSave(s)) return true;
    const token = policy.sessionToken(s);
    policy.onSaveStart?.(s);
    try {
      const id = await saveDraft(policy.toInput(s), policy.draftId(s));
      const cur = policy.getSession();
      // The session may have been sent / discarded / replaced mid-write.
      if (cur && policy.sessionToken(cur) === token) {
        policy.onSaved(cur, id);
      } else {
        // The session is gone (send/discard) or was replaced while the write
        // was in flight. Its lifecycle path already deleted the persisted row
        // — our just-completed write would otherwise RESURRECT it as an
        // orphan no live session references. Compensate by deleting the row
        // we just wrote (idempotent; a prior delete is a harmless no-op).
        await deleteDraft(id).catch(() => {});
      }
      return true;
    } catch (err) {
      (policy.onError ?? ((e) => console.error('[draft-autosave] save failed:', e)))(err);
      return false;
    } finally {
      policy.onSettled?.();
    }
  }

  function scheduleSave(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void saveNow();
    }, DEBOUNCE_MS);
  }

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = policy.subscribe((next, prev) => {
        if (!next || !policy.shouldSave(next)) return;
        if (prev && !policy.contentChanged(prev, next)) return;
        scheduleSave();
      });
    },
    stop() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
    async flush() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      return saveNow();
    },
  };
}
