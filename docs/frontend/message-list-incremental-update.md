# Message List: Incremental Update Architecture

**Date:** 2026-06-28
**Status:** Design (not yet implemented)

## Problem

The message list flickers periodically because `threadStore.loadThreads()` does a **full replace** of the threads array on every refresh:

1. `set({ threads: [] })` — clears the entire state, React renders empty list
2. `await getThreads(...)` — SQLite query (5-50ms)
3. `set({ threads: newData })` — React re-renders with new data

The brief empty-state render between steps 1 and 3 is the visible flicker. This happens on every `sync:delta` event (new mail arrival in any folder, label changes, etc.).

Additionally, when a single message's flag changes (read/unread, starred) or a new message arrives, the entire thread list is replaced — all virtualized rows re-render, and scroll position may reset.

## Goal

- **Incremental insert**: New threads are inserted into the existing array without replacing it
- **In-place update**: Changed threads (flag updates, snippet changes) update their specific entry in-place
- **No flicker**: The list never goes empty; old data remains visible during refresh

## Analysis

### Current data flow

```
sync:delta event
  → useSyncEvents handler
    → threadStore.refresh()
      → loadThreads(accountId, labelId)
        → set({ threads: [], cursor: null })    ← CLEARS EVERYTHING
        → await getThreads(...)                  ← SQLite query
        → set({ threads: new, cursor: next })    ← FULL REPLACE
```

### Problematic state transitions

| Step | State | UI effect |
|------|-------|-----------|
| Before refresh | `threads: [A, B, C, D]` | Normal list |
| `set({ threads: [] })` | `threads: []` | **Flicker — empty list** |
| `set({ threads: [A', B', C', D', E] })` | Full replace | Full re-render |

### What should happen

| Scenario | Current behavior | Desired behavior |
|----------|-----------------|------------------|
| New message arrives (UID 5 in folder X) | Full replace of thread list | Insert thread-5 at correct position (sorted by date) |
| Flag change on message UID 3 | Full replace of thread list | Update thread-3's `isRead`/`isStarred` in-place |
| Message deleted (UID 4 vanishes) | Full replace of thread list | Remove thread-4 from array |
| Initial load / folder switch | Load from scratch | Load from scratch (current behavior is correct for this) |
| Pull-to-refresh | Load from scratch | Show spinner, keep old data, replace when done |

## Solution

### Phase 1: Stop clearing threads on refresh (low risk)

**File:** `kylins.client.frontend/src/stores/threadStore.ts`

Split `loadThreads` into two modes:

```typescript
// Initial load / folder switch — clears and reloads
loadThreads: async (accountId, labelId) => {
  set({ isLoading: true, currentQuery: { accountId, labelId }, threads: [], cursor: null });
  try {
    const { threads, nextCursor } = await getThreads(accountId, { labelId });
    set({ threads, cursor: nextCursor, isLoading: false });
  } catch {
    set({ isLoading: false });
  }
},

// Background refresh — keeps old data, replaces only when new data arrives
refreshThreads: async () => {
  const q = get().currentQuery;
  if (!q) return;
  set({ isLoading: true });  // DON'T clear threads
  try {
    const { threads, nextCursor } = await getThreads(q.accountId, { labelId: q.labelId });
    set({ threads, cursor: nextCursor, isLoading: false });
  } catch {
    set({ isLoading: false });
  }
},
```

### Phase 2: Incremental insert for new messages (medium risk)

Add a delta-based insert method that only inserts new threads:

```typescript
// Called when sync:delta fires for the currently viewed folder
applyMessageDelta: async (accountId: string, labelId: string) => {
  const q = get().currentQuery;
  if (!q || q.accountId !== accountId || q.labelId !== labelId) return;

  // Fetch only threads that changed since our cursor
  const { threads: newThreads } = await getThreads(accountId, {
    labelId,
    minDate: get().threads[0]?.lastMessageAt,  // newer than our newest
  });

  if (newThreads.length === 0) return;

  // Merge new threads into existing array, maintaining sort order
  set((s) => ({
    threads: mergeSortedByDate(s.threads, newThreads),
  }));
},
```

### Phase 3: In-place flag update (low risk, already partially done)

The `markThreadRead` and `toggleThreadStarred` methods already update in-place via `set()`:

```typescript
// Existing code in threadStore — in-place update, correct pattern
markThreadRead: async (thread, read, messages) => {
  set((s) => ({
    threads: s.threads.map((t) =>
      t.id === thread.id ? { ...t, isRead: read } : t
    ),
  }));
  // ... server sync
},
```

Extend this pattern to handle flag changes from server-side sync:

```typescript
// Called by sync:delta handler for currently-viewed folder
applyFlagUpdates: (updates: Array<{ threadId: string; isRead?: boolean; isStarred?: boolean }>) => {
  set((s) => ({
    threads: s.threads.map((t) => {
      const u = updates.find((u) => u.threadId === t.id);
      return u ? { ...t, ...u } : t;
    }),
  }));
},
```

### Phase 4: Smart delta dispatch (frontend handler)

Only refresh when the delta is relevant to the current view:

```typescript
// useSyncEvents.ts
await listen<{ accountId: string; labelId?: string; table?: string }>(
  'sync:delta',
  (e) => {
    useFolderStore.getState().loadLabels().catch(() => {});

    const q = useThreadStore.getState().currentQuery;
    if (!q) return;

    // Label-only delta: just the folder list changed, no need to touch threads
    if (e.payload.table === 'labels') return;

    // Message delta for a different folder: skip (don't reload current view)
    if (e.payload.labelId && e.payload.labelId !== q.labelId) return;

    // Message delta for current folder: incremental refresh
    useThreadStore.getState().applyMessageDelta(q.accountId, q.labelId).catch(() => {});
  },
);
```

## Related files

| File | Role |
|------|------|
| `src/stores/threadStore.ts` | Thread state, loadThreads, refresh |
| `src/hooks/useSyncEvents.ts` | Sync event → store bridge |
| `src/components/layout/MessageList.tsx` | Virtualized message list |
| `src/services/db/threads.ts` | `getThreads()` DB query |
| `src/sync_engine/engine.rs` | Emits `sync:delta` events |

## References

- `docs/frontend/message-list-flicker-root-cause.md` — investigation that led to this design
- `docs/sync-engine/sync-engine-flag-move-detection.md` — backend changes needed to populate `updated` in FolderDelta
