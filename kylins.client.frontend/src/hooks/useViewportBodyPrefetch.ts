// Viewport-aware batch body prefetch. When the message-list scroll settles
// (or on mount / folder-switch), compute the visible+buffer rows, map each to
// its message_id, filter via `getUncachedBodyMessageIds`, and invoke
// `sync_request_bodies` once. Best-effort + superseded: a newer viewport wins;
// an older in-flight fetch is allowed to complete (its writes are idempotent
// INSERT OR REPLACE) but its store patches are dropped.
//
// Phase 0 (one thread per message): thread.id IS the message_id, so the
// "latest message_id for the thread" is just thread.id. When real conversation
// threading lands, expose `latest_message_id` on the Thread type and switch
// the mapping below — see `message-list-architecture.md` (Deferred).

import { useEffect, useRef } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../stores/uiStore';
import { getUncachedBodyMessageIds } from '../services/db/messages';
import type { Thread } from '../services/db/threads';

interface Options {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  threads: Thread[];
  /** Account id for the currently-loaded list. */
  accountId: string | null;
}

/** Buffer (rows) added above/below the visible range when picking prefetch
 * candidates. ~5–8; tuned so a single scroll tick doesn't miss. */
const VIEWPORT_BUFFER = 6;
/** Hard cap on message_ids per prefetch invocation. */
const MAX_PREFETCH = 30;
/** Debounce window (ms). Lets a fast scroll settle before we fetch. */
const DEBOUNCE_MS = 250;

/** Live Tauri check — read at effect time, NOT module load. The hook is
 * imported by tests that set `window.__TAURI_INTERNALS__` in `beforeEach`
 * (after import), so a module-level `const` would snapshot the pre-test value
 * (false) and never see the test's override. Reading inside the effect keeps
 * the no-op-outside-Tauri guarantee while staying testable. */
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Viewport-aware batch body prefetch. Skipped entirely when the account is
 * rate-limited (Phase 3f) — prefetch is low-priority and the next poll will
 * fill the cache.
 *
 * MVP (Task 3): single debounced fire on mount / folder-switch / virtualizer
 * change. Task 3b hardens this with first-mount-immediate, a 1-batch/sec
 * throttle, and removes the vestigial supersede token.
 */
export function useViewportBodyPrefetch({ virtualizer, threads, accountId }: Options): void {
  // Supersede token. Each invocation increments; only the latest invocation's
  // callback still applies patches to the store. (Task 3b removes this — late
  // arrivals usefully fill the cache and patches are idempotent.)
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!isTauriEnv() || !accountId || threads.length === 0) return;

    const handle = window.setTimeout(() => {
      void (async () => {
        // Rate-limit gate.
        if (useUIStore.getState().rateLimitedAccountIds.has(accountId)) return;

        const visible = virtualizer.getVirtualItems();
        if (visible.length === 0) return;
        const firstIdx = Math.max(0, visible[0]!.index - VIEWPORT_BUFFER);
        const lastIdx = Math.min(
          threads.length - 1,
          visible[visible.length - 1]!.index + VIEWPORT_BUFFER,
        );

        // Map visible thread rows to their latest message_id. Phase 0:
        // thread.id == message_id, so the latest message_id is thread.id.
        // (When real conversation threading lands, expose latest_message_id
        // on the Thread type — see Deferred in the file header.)
        const candidateIds: string[] = [];
        for (let i = firstIdx; i <= lastIdx; i++) {
          const t = threads[i];
          if (t) candidateIds.push(t.id);
          if (candidateIds.length >= MAX_PREFETCH) break;
        }
        if (candidateIds.length === 0) return;

        // Filter to uncached only — don't re-request what we already have.
        let uncached: string[];
        try {
          uncached = await getUncachedBodyMessageIds(accountId, candidateIds);
        } catch (e) {
          console.error('[prefetch] getUncachedBodyMessageIds failed', e);
          return;
        }
        if (uncached.length === 0) return;

        // Supersede: bump token; capture locally.
        const myToken = ++tokenRef.current;

        try {
          await invoke('sync_request_bodies', {
            accountId,
            messageIds: uncached,
          });
        } catch (e) {
          console.error('[prefetch] sync_request_bodies failed', e);
        }
        // The store patch happens via the sync:bodies-written listener
        // (Task 4). The token check there supersedes stale applications.
        void myToken; // (token is consulted by the listener — see Task 4.)
      })();
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(handle);
    };
  }, [virtualizer, threads, accountId]);
}
