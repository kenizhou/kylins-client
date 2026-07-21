# Design: Outlook-style multi-select in the message list

Date: 2026-07-21
Status: Approved (design)

## Goal

The message list (`kylins.client.frontend/src/components/layout/MessageList.tsx`)
currently supports exactly one selected thread (`threadStore.selectedThreadId`).
This change adds full Outlook-style multi-select: Ctrl/Shift modifier clicks,
Ctrl+A, Shift+Arrow range extension, and bulk context-menu actions.

## Requirements (agreed)

- **Full Outlook-style scope**: Ctrl+click toggle, Shift+click range, Ctrl+A
  select-all, and context-menu actions (delete, archive, mark read/unread, flag,
  move) applied to the whole selection.
- **Reading pane**: shows the anchor message — the last plain-clicked (or
  Ctrl-clicked-in) thread — while other rows show as selected.
- **Keyboard**: Shift+Arrow extends the selection range from the anchor; plain
  arrows move selection to a single thread (collapsing multi-select); Ctrl+A
  selects all loaded threads.
- **Plain click** on any row collapses the selection to just that row.

## Out of scope

- Checkbox column, drag/marquee selection.
- Bulk Reply/Reply All/Forward (these remain anchor-only).
- Persisting selection across folder switches (selection resets on folder change).

## Architecture

### State — `src/stores/threadStore.ts`

The store owns the selection so context menus and future surfaces (ribbon,
status bar) can act on it without prop drilling.

New state:

- `selectedThreadIds: string[]` — all selected thread ids, anchor last.
- `selectionAnchorId: string | null` — last plain-clicked / Ctrl-clicked-in
  thread; drives the reading pane and the Shift-range start.

`selectedThreadId` remains as the anchor alias so `ReadingPane`, the standalone
viewer, and `viewStore.selectedThreadIds` (already populated by the existing
`setSelectedThread` helper) keep working unchanged. Invariant:
`selectedThreadId === selectionAnchorId`, and `selectionAnchorId` is either
`null` or a member of `selectedThreadIds`.

New actions:

- `setSelection(ids: string[], anchorId: string | null)` — sets both fields and
  syncs `viewStore.selectedThreadIds`. When the anchor changes, runs the same
  body-load pipeline as today's `selectThread` (so the reading pane follows the
  anchor). The existing "mark the thread being LEFT as read" rule applies to
  the previous anchor only.
- Bulk mutations, each reusing the existing single-thread logic (same
  `sync_apply_mutation` ops, folder unread-count adjustments, and
  `thread:deleted` events), with React state updated once per batch rather than
  per thread:
  - `markThreadsRead(threads: Thread[], read: boolean)`
  - `toggleThreadsStarred(threads: Thread[])`
  - `deleteThreads(threads: Thread[])`
  - `archiveThreads(threads: Thread[])` (via `moveThreadToRole`-equivalent logic
    per thread, matching the existing single-thread archive path)
  - `moveThreads(threads: Thread[], dstLabel: string, dstFolderPath: string)`

Selection lifecycle:

- `loadThreads` (folder switch) resets `selectedThreadIds` /
  `selectionAnchorId` / `selectedThreadId` to empty.
- Any mutation that removes threads from the list (delete/move/archive) prunes
  them from `selectedThreadIds`; if the anchor is removed, the anchor moves to
  the next remaining thread (same next-thread rule as today's `deleteThread`)
  or clears.

### Interaction — `src/components/layout/MessageList.tsx`

Row click handling receives the mouse event and dispatches:

- **Plain click** → `setSelection([thread.id], thread.id)` (current behavior).
- **Ctrl+click** → toggle membership. Toggling in makes it the anchor (loads it
  in the reading pane). Toggling the anchor out moves the anchor/pane to the
  next selected row, or clears the pane when the selection becomes empty.
- **Shift+click** → select the contiguous range from the current anchor to the
  clicked row, computed over `filteredItems` while skipping `kind: 'group'`
  headers. The anchor itself does not change.
- **Ctrl+A** (listbox focused) → select all loaded threads (all
  `kind: 'thread'` items in `filteredItems`); anchor unchanged (falls back to
  first row if there was no anchor).
- **ArrowUp/ArrowDown** → collapse to single selection and move (current
  behavior).
- **Shift+ArrowUp/ArrowDown** → extend/shrink the contiguous range around the
  anchor by one row; the anchor stays fixed, the reading pane keeps showing the
  anchor.
- **Right-click** on a selected row → the context menu applies to the whole
  selection. Right-click on an unselected row → collapse to that row first,
  then show the single-target menu (Outlook behavior).
- **Double-click** → unchanged (opens the anchor thread in a viewer window).

Context menu changes:

- When the menu targets a multi-selection, Mark Read/Unread, Follow Up, Move,
  Archive, and Delete invoke the bulk store actions and their labels show the
  count (e.g. "Delete 5 conversations"). Mark Read vs Mark Unread follows the
  anchor thread's state, applied to all.
- Copy, Quick Print, Categorize, Find Related, Rules, Junk stay disabled.
- Reply, Reply All, Forward remain enabled but act on the anchor thread only.

Accessibility:

- Listbox gets `aria-multiselectable="true"`.
- Each row's `aria-selected` reflects membership in `selectedThreadIds`.
- `aria-activedescendant` continues to track the anchor.

## Data flow

```
MessageList click/key handlers
  → threadStore.setSelection(ids, anchorId)
      → updates selectedThreadIds / selectionAnchorId / selectedThreadId
      → viewStore.setSelectedThreadIds / setSelectedMessage (anchor body load)
  → bulk actions (context menu)
      → threadStore.<bulk mutation>(threads)
          → one batched set() for list state
          → per-thread sync_apply_mutation invokes (fire-and-forget, as today)
          → folderStore unread-count adjustments
```

## Error handling

Bulk mutations follow the existing single-thread pattern: optimistic local
state update, fire-and-forget `sync_apply_mutation` with `.catch(console.error)`.
A failure in one thread's invoke does not abort the remaining threads. Body-load
failures for the anchor keep today's behavior (console error + cached/null body
fallback; crypto failures push a toast).

## Testing

Tests live under `tests/` mirroring `src/`, mocking `getDb()` and Tauri APIs.

- `tests/stores/threadStore.test.ts` (extend or new file):
  - `setSelection` sets ids + anchor and syncs `viewStore.selectedThreadIds`.
  - Anchor change triggers the mark-previous-anchor-read rule.
  - `deleteThreads` prunes selection, moves anchor to next thread, updates
    unread counts once per affected unread thread, emits `thread:deleted` per
    thread.
  - `markThreadsRead` skips threads already in the target state.
- `tests/components/layout/MessageList.test.tsx` (extend):
  - Ctrl+click toggles a row; Shift+click selects a range skipping group
    headers; plain click collapses.
  - Ctrl+A selects all loaded threads.
  - Right-click on selected row keeps the selection (menu applies to all);
    right-click on unselected row collapses first.
  - `aria-multiselectable` present; `aria-selected` true for each selected row.
