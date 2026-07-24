// Account-scoped index of conversation thread_ids that have a saved local
// draft (`local_drafts`). The message list uses it to keep the [Draft] chip
// on a conversation row after an app reload — the inline-composer session
// that produced the draft is memory-only, but the persisted row is not.
//
// Refreshed on account switch and on every `DRAFTS_CHANGED_EVENT` (autosave /
// manual save / delete / send cleanup). Reads are per-row boolean selectors,
// so rows only re-render when their own chip state flips.

import { create } from 'zustand';
import { listDraftsForAccount } from '@/services/composer/drafts';

interface DraftIndexState {
  /** Account the current index was built for (staleness guard). */
  accountId: string | null;
  threadIds: ReadonlySet<string>;
  refresh: (accountId: string) => Promise<void>;
}

export const useDraftIndexStore = create<DraftIndexState>((set, get) => ({
  accountId: null,
  threadIds: new Set<string>(),
  refresh: async (accountId) => {
    set({ accountId });
    try {
      const rows = await listDraftsForAccount(accountId);
      // A newer refresh for a different account superseded this one.
      if (get().accountId !== accountId) return;
      set({
        threadIds: new Set(
          rows.map((r) => r.thread_id).filter((id): id is string => typeof id === 'string'),
        ),
      });
    } catch (e) {
      console.error('[draft-index] refresh failed', e);
    }
  },
}));
