# Message List Multi-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Outlook-style multi-select (Ctrl/Shift click, Ctrl+A, Shift+Arrow, bulk context-menu actions) to the message list.

**Architecture:** Selection state lives in `threadStore` (`selectedThreadIds` + `selectionAnchorId`, with `selectedThreadId` kept as the anchor alias). `setSelection` is the single entry point; the existing `selectThread` delegates to it. Bulk mutations (`markThreadsRead`, `setThreadsStarred`, `deleteThreads`, `moveThreads`, `moveThreadsToRole`) batch the React state update and fire one `sync_apply_mutation` per thread, and the existing single-thread actions delegate to them. `MessageList` dispatches modifier clicks/keys into `setSelection` and targets context-menu actions at the selection.

**Tech Stack:** React 19, Zustand, Vitest 4 + Testing Library (jsdom), Tauri `invoke` (mocked in tests).

**Spec:** `docs/superpowers/specs/2026-07-21-message-list-multi-select-design.md`

## Global Constraints

- All frontend commands run from `kylins.client.frontend/`.
- Run tests with `npx vitest run <file>` (NOT `npm test` — that is watch mode).
- TypeScript strict: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` are on. Indexing an array yields `T | undefined`.
- Tests never hit a real DB or Tauri runtime: `getDb()`, `@tauri-apps/api/core`, and service modules are mocked.
- Vitest `globals: true`; existing test files still import from 'vitest' — follow each file's existing import style.
- Reading pane shows the **anchor** message; bulk Reply/Forward stay anchor-only; no checkbox column or drag-select (out of scope).

---

### Task 1: threadStore — selection state + `setSelection` + body-load extraction

**Files:**
- Modify: `kylins.client.frontend/src/stores/threadStore.ts`
- Test: `kylins.client.frontend/tests/stores/threadStore.test.ts`

**Interfaces:**
- Consumes: existing `Thread`, `DbMessageRow` from `src/services/db/threads`; `useViewStore.setSelectedThreadIds/setSelectedMessage`; `useFolderStore`; `getMessageBody`, `openCryptoMessage`, `getMessageCryptoResult`, `invoke`.
- Produces (used by Tasks 2-8):
  - `useThreadStore` state fields: `selectedThreadIds: string[]`, `selectionAnchorId: string | null`
  - `setSelection(ids: string[], anchorId: string | null): Promise<void>` — sets `selectedThreadIds`, `selectionAnchorId`, `selectedThreadId` (anchor alias); syncs `viewStore.selectedThreadIds`; marks the previous anchor read when the anchor changes; loads the anchor body into `viewStore.selectedMessage` when the anchor changes (clears it when anchor becomes null). Ids not present in `state.threads` are dropped.
  - Internal closure `openThreadBody(thread: Thread): Promise<void>` — the existing `selectThread` body pipeline, shared by later tasks. Not part of the public interface.
  - Invariant: `selectedThreadId === selectionAnchorId`; `selectionAnchorId` is null or a member of `selectedThreadIds`.

- [ ] **Step 1: Update the test reset helper and write the failing tests**

In `kylins.client.frontend/tests/stores/threadStore.test.ts`, update `reset()` (around line 64) to include the new fields:

```ts
function reset() {
  useThreadStore.setState({
    threads: [],
    selectedThreadId: null,
    selectedThreadIds: [],
    selectionAnchorId: null,
    isLoading: false,
    cursor: null,
    currentQuery: null,
  });
  // ...rest unchanged
}
```

Append these describes at the end of the file (the existing `messageRow` helper at module scope is reused — it is evaluated before any test runs):

```ts
describe('threadStore.setSelection', () => {
  it('sets the selection ids + anchor and syncs viewStore', async () => {
    useThreadStore.setState({
      threads: [thread({ id: 't1', isRead: true }), thread({ id: 't2', isRead: true })],
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);

    await useThreadStore.getState().setSelection(['t1', 't2'], 't1');

    const s = useThreadStore.getState();
    expect(s.selectedThreadIds).toEqual(['t1', 't2']);
    expect(s.selectionAnchorId).toBe('t1');
    expect(s.selectedThreadId).toBe('t1');
    expect(useViewStore.getState().selectedThreadIds).toEqual(['t1', 't2']);
  });

  it('marks the previous anchor read when the anchor moves', async () => {
    useThreadStore.setState({
      threads: [thread({ id: 't1', isRead: false }), thread({ id: 't2', isRead: true })],
    });
    vi.mocked(getMessagesForThread).mockImplementation(async (_acc, id) =>
      id === 't1' ? [messageRow()] : [],
    );
    vi.mocked(getMessageBody).mockResolvedValue(null);

    await useThreadStore.getState().setSelection(['t1'], 't1');
    await useThreadStore.getState().setSelection(['t1', 't2'], 't2');

    expect(invoke).toHaveBeenCalledWith('sync_apply_mutation', {
      accountId: 'a1',
      op: {
        type: 'markRead',
        threadId: 't1',
        messageIds: ['m1'],
        folderPath: 'INBOX',
        uids: [4242],
        read: true,
      },
    });
    expect(useThreadStore.getState().selectedThreadId).toBe('t2');
  });

  it('does not reload the body when only the selection (not the anchor) changes', async () => {
    useThreadStore.setState({
      threads: [thread({ id: 't1', isRead: true }), thread({ id: 't2', isRead: true })],
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);

    await useThreadStore.getState().setSelection(['t1'], 't1');
    vi.mocked(getMessagesForThread).mockClear();
    await useThreadStore.getState().setSelection(['t1', 't2'], 't1');

    expect(getMessagesForThread).not.toHaveBeenCalled();
  });

  it('clears the reading pane when the selection empties', async () => {
    useThreadStore.setState({ threads: [thread({ id: 't1', isRead: true })] });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);

    await useThreadStore.getState().setSelection(['t1'], 't1');
    await useThreadStore.getState().setSelection([], null);

    const s = useThreadStore.getState();
    expect(s.selectedThreadIds).toEqual([]);
    expect(s.selectionAnchorId).toBeNull();
    expect(s.selectedThreadId).toBeNull();
    expect(useViewStore.getState().selectedThreadIds).toEqual([]);
    expect(useViewStore.getState().selectedMessage).toBeNull();
  });
});

describe('threadStore.loadThreads selection reset', () => {
  it('clears the selection on folder switch', async () => {
    useThreadStore.setState({
      threads: [thread({ id: 't1' })],
      selectedThreadId: 't1',
      selectedThreadIds: ['t1'],
      selectionAnchorId: 't1',
    });
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't9' })],
      nextCursor: null,
    });

    await useThreadStore.getState().loadThreads('a1', 'sent');

    const s = useThreadStore.getState();
    expect(s.selectedThreadId).toBeNull();
    expect(s.selectedThreadIds).toEqual([]);
    expect(s.selectionAnchorId).toBeNull();
    expect(useViewStore.getState().selectedThreadIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts`
Expected: FAIL — `setSelection is not a function` (and the loadThreads reset test fails because the fields are not cleared).

- [ ] **Step 3: Implement the store changes**

In `kylins.client.frontend/src/stores/threadStore.ts`:

**3a.** Delete the module-level `setSelectedThread` helper (lines 30-33). Its only callers (`selectThread`, `deleteThread`, `moveThread`) are rewritten in this task and Tasks 4-5.

**3b.** Update the `ThreadState` interface — add after `selectedThreadId: string | null;`:

```ts
  selectedThreadIds: string[];
  selectionAnchorId: string | null;
```

and add to the action list (after the `selectThread` line):

```ts
  setSelection: (ids: string[], anchorId: string | null) => Promise<void>;
```

**3c.** Restructure the `create((set, get) => ({ ... }))` body into `create((set, get) => { ... return { ... }; })` so the body-load pipeline can live in a shared closure. Immediately inside the callback, add `openThreadBody` — this is the existing `selectThread` message/body pipeline moved verbatim (the whole `try { const messages = ... } catch` block), with `thread` as its parameter:

```ts
export const useThreadStore = create<ThreadState>((set, get) => {
  /**
   * Load the anchor thread's latest message into `viewStore.selectedMessage`.
   * This is the exact pipeline formerly inlined in `selectThread` (crypto path
   * with session decryptedCache, plain path with on-demand body fetch). Shared
   * by setSelection and the bulk mutations that re-anchor the reading pane.
   */
  const openThreadBody = async (thread: Thread): Promise<void> => {
    try {
      const messages = await getMessagesForThread(thread.accountId, thread.id);
      const latest = messages[messages.length - 1] ?? null;
      if (latest) {
        // S/MIME crypto path (Phase 1b Plan 4): an encrypted/signed message is
        // opened through the decrypt + verify pipeline (`openCryptoMessage`)
        // instead of the plain body fetch. The decrypted plaintext is
        // SESSION-ONLY — it flows into `viewStore.selectedMessage.html`
        // (in-memory React state) + `viewStore.decryptedCache` (RAM) so
        // re-opening doesn't re-decrypt. NEVER written to disk. On decrypt
        // failure we set `decryptState: 'failed'` + push a toast so ReadingPane
        // (T4) shows the decrypt-failure panel; we do NOT crash the open flow.
        // Rust `MessageRow.is_encrypted`/`is_signed` are `bool` → JSON
        // `true`/`false` (NOT 0/1 ints — the read path was cut over from
        // plugin-sql to Rust db commands). Coerce truthily; `=== 1` would
        // silently never match a boolean, gating the crypto path off for EVERY
        // encrypted message (regression that left the smime.p7m envelope
        // rendering as a plain attachment instead of decrypting).
        const isCrypto = !!latest.is_encrypted || !!latest.is_signed;
        if (isCrypto) {
          const cached = useViewStore.getState().decryptedCache[latest.id];
          let mail: MailMessage;
          if (cached) {
            // Session cache hit — skip the crypto invoke entirely. The cached
            // plaintext (RAM) is the source of truth for re-open. Re-attach the
            // persisted verification outcome via getMessageCryptoResult (cheap
            // DB read, no decrypt; always-current — reflects any trust decision
            // since first open) so the CryptoBadge renders on re-open, not just
            // first open. Without this the badge vanishes on every re-open.
            mail = mapMessageToMailMessage(latest, cached.html);
            mail.text = cached.text;
            const cr = await getMessageCryptoResult(thread.accountId, latest.id);
            if (cr) {
              mail.signatureState = cr.signatureState as MailMessage['signatureState'];
              mail.decryptState = cr.decryptState as MailMessage['decryptState'];
              mail.signerEmail = cr.signerEmail ?? undefined;
              mail.signerFingerprint = cr.signerFingerprint ?? undefined;
              mail.revocationState = cr.revocationState as MailMessage['revocationState'];
            }
          } else {
            try {
              const result = await openCryptoMessage(thread.accountId, latest.id);
              // Cache the plaintext BEFORE mapping so a re-open in the same
              // session hits the cache even if setSelectedMessage throws below.
              useViewStore
                .getState()
                .setDecrypted(latest.id, result.plaintextHtml, result.plaintextText);
              mail = mapMessageToMailMessage(latest, result.plaintextHtml);
              mail.text = result.plaintextText;
              const cr = result.cryptoResult;
              // Layer the persisted verification outcome onto the MailMessage.
              // Casts narrow the backend's `string` fields to the MailMessage
              // literal unions — the Rust side emits exactly these variants per
              // the `message_crypto_results` CHECK constraints.
              mail.signatureState = cr.signatureState as MailMessage['signatureState'];
              mail.decryptState = cr.decryptState as MailMessage['decryptState'];
              mail.signerEmail = cr.signerEmail ?? undefined;
              mail.signerFingerprint = cr.signerFingerprint ?? undefined;
              mail.revocationState = cr.revocationState as MailMessage['revocationState'];
            } catch (e) {
              // Decrypt/verify failure: surface the failure panel + toast. The
              // base MailMessage (from the DB row) still carries isEncrypted /
              // isSigned so the ReadingPane knows it was a crypto message.
              console.error('[openThreadBody] crypto open failed:', e);
              useToastStore
                .getState()
                .push(`Decrypt failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
              mail = mapMessageToMailMessage(latest, null);
              mail.decryptState = 'failed';
            }
          }
          useViewStore.getState().setSelectedMessage(mail);
        } else {
          // Plain path (unchanged) — headers-first body fetch. The folder sweep
          // no longer downloads bodies, so open them on demand. If the body is
          // uncached, ask the backend to fetch it (sync_request_bodies →
          // source.fetch_body → message_bodies upsert) then re-read. Best
          // effort: on failure we render whatever the cache has (null body →
          // reading pane shows the text fallback).
          let body = await getMessageBody(thread.accountId, latest.id);
          console.log(
            '[select] latestId=',
            latest.id,
            'accountId=',
            thread.accountId,
            'body=',
            body ? `${body.bodyHtml?.length ?? 'null'} chars` : 'null',
          );
          if (!body || body.bodyHtml == null) {
            console.log('[select] CACHE MISS for', latest.id, '— triggering sync_request_bodies');
            try {
              await invoke('sync_request_bodies', {
                accountId: thread.accountId,
                messageIds: [latest.id],
              });
              body = await getMessageBody(thread.accountId, latest.id);
            } catch (e) {
              console.error('on-demand body fetch failed:', e);
            }
          }
          useViewStore
            .getState()
            .setSelectedMessage(mapMessageToMailMessage(latest, body?.bodyHtml ?? null));
        }
      } else {
        useViewStore.getState().setSelectedMessage(null);
      }
      // Note: opening a thread no longer marks it read here — that happens
      // when the user navigates away (see setSelection).
    } catch (e) {
      console.error('Failed to load thread messages:', e);
    }
  };

  return {
    // ...existing state + actions, modified as below...
  };
});
```

**3d.** Initial state — add the two fields:

```ts
    threads: [],
    selectedThreadId: null,
    selectedThreadIds: [],
    selectionAnchorId: null,
    isLoading: false,
    cursor: null,
    currentQuery: null,
```

**3e.** `loadThreads` — extend its first `set` to reset the selection, and clear the viewStore selection:

```ts
  loadThreads: async (accountId, labelId) => {
    set({
      isLoading: true,
      currentQuery: { accountId, labelId },
      threads: [],
      cursor: null,
      selectedThreadId: null,
      selectedThreadIds: [],
      selectionAnchorId: null,
    });
    useViewStore.getState().setSelectedThreadIds([]);
    useViewStore.getState().setSelectedMessage(null);
    try {
      const { threads, nextCursor } = await getThreads(accountId, { labelId });
      set({ threads, cursor: nextCursor });
    } finally {
      set({ isLoading: false });
    }
  },
```

**3f.** Replace `selectThread` with a delegation and add `setSelection`:

```ts
  selectThread: async (thread) => {
    await get().setSelection([thread.id], thread.id);
  },

  setSelection: async (ids, anchorId) => {
    const prevAnchorId = get().selectedThreadId;
    // Only loaded threads are selectable (Ctrl+A ranges, stale ids after
    // pagination/filtering are dropped).
    const validIds = ids.filter((id) => get().threads.some((t) => t.id === id));
    const nextAnchorId =
      anchorId && validIds.includes(anchorId)
        ? anchorId
        : (validIds[validIds.length - 1] ?? null);

    set({
      selectedThreadIds: validIds,
      selectionAnchorId: nextAnchorId,
      selectedThreadId: nextAnchorId,
    });
    useViewStore.getState().setSelectedThreadIds(validIds);

    // Outlook-style read timing: the anchor being LEFT is marked read, not the
    // anchor being opened — so the unread styling (colorbar, bold) stays while
    // reading and is only consumed when the user moves on.
    if (prevAnchorId && prevAnchorId !== nextAnchorId) {
      const previous = get().threads.find((t) => t.id === prevAnchorId);
      if (previous && !previous.isRead) {
        await get().markThreadRead(previous, true);
      }
    }

    // Selection changed but the reading-pane target didn't — nothing to load.
    if (nextAnchorId === prevAnchorId) return;

    const anchorThread = nextAnchorId
      ? get().threads.find((t) => t.id === nextAnchorId)
      : undefined;
    if (!anchorThread) {
      useViewStore.getState().setSelectedMessage(null);
      return;
    }
    await openThreadBody(anchorThread);
  },
```

**3g.** In `deleteThread` and `moveThread`, replace the two `setSelectedThread(...)` call sites so the file compiles until Tasks 4-5 rewrite them. In both, replace:

```ts
      selectedThreadId: setSelectedThread(
        nextThread?.id ?? (wasSelected ? null : state.selectedThreadId),
      ),
```

with:

```ts
      selectedThreadId: nextThread?.id ?? (wasSelected ? null : state.selectedThreadId),
```

and immediately after each `set({ ... })` block add (to keep the viewStore bridge intact):

```ts
    useViewStore
      .getState()
      .setSelectedThreadIds(
        get().selectedThreadId ? [get().selectedThreadId!] : [],
      );
```

(Tasks 4 and 5 replace these methods entirely; this is only to keep Task 1 compiling and its tests green.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts`
Expected: PASS (all existing + 5 new tests). Also run `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/stores/threadStore.ts kylins.client.frontend/tests/stores/threadStore.test.ts
git commit -m "feat(frontend): multi-select state + setSelection in threadStore"
```

---

### Task 2: threadStore — bulk `markThreadsRead`

**Files:**
- Modify: `kylins.client.frontend/src/stores/threadStore.ts`
- Test: `kylins.client.frontend/tests/stores/threadStore.test.ts`

**Interfaces:**
- Consumes: Task 1's store structure; `getThreadMessages` module helper.
- Produces: `markThreadsRead(threads: Thread[], read: boolean): Promise<void>` — skips threads already in the target state; fetches messages for all targets (`Promise.all`); ONE batched `set()` for `state.threads`; then per target: one `sync_apply_mutation` `markRead` op (fire-and-forget with `.catch(console.error)`) and one folder unread-count adjustment (only when `currentQuery.labelId` is set). `markThreadRead(thread, read)` delegates to it (the legacy `messages` hint param is kept for API compatibility but unused).

- [ ] **Step 1: Write the failing tests**

Append to `kylins.client.frontend/tests/stores/threadStore.test.ts`:

```ts
describe('threadStore.markThreadsRead', () => {
  it('marks multiple threads read with one op per thread and adjusts counts per thread', async () => {
    useThreadStore.setState({
      threads: [
        thread({ id: 't1', isRead: false }),
        thread({ id: 't2', isRead: false }),
        thread({ id: 't3', isRead: true }),
      ],
      currentQuery: { accountId: 'a1', labelId: 'inbox' },
    });
    useFolderStore.setState({ unreadCounts: { a1__inbox: 5 } });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow()]);

    await useThreadStore.getState().markThreadsRead(
      [
        thread({ id: 't1', isRead: false }),
        thread({ id: 't2', isRead: false }),
        thread({ id: 't3', isRead: true }),
      ],
      true,
    );

    expect(useThreadStore.getState().threads.map((t) => t.isRead)).toEqual([true, true, true]);
    expect(useFolderStore.getState().unreadCounts['a1__inbox']).toBe(3);
    // t3 was already read — no op for it.
    const markReadOps = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'sync_apply_mutation' &&
          (args as { op: { type: string } }).op.type === 'markRead',
      );
    expect(markReadOps).toHaveLength(2);
    expect(markReadOps[0]?.[1]).toEqual({
      accountId: 'a1',
      op: {
        type: 'markRead',
        threadId: 't1',
        messageIds: ['m1'],
        folderPath: 'INBOX',
        uids: [4242],
        read: true,
      },
    });
  });

  it('marks multiple threads unread and increments the count per thread', async () => {
    useThreadStore.setState({
      threads: [thread({ id: 't1', isRead: true }), thread({ id: 't2', isRead: true })],
      currentQuery: { accountId: 'a1', labelId: 'inbox' },
    });
    useFolderStore.setState({ unreadCounts: { a1__inbox: 1 } });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow()]);

    await useThreadStore.getState().markThreadsRead(
      [thread({ id: 't1', isRead: true }), thread({ id: 't2', isRead: true })],
      false,
    );

    expect(useThreadStore.getState().threads.map((t) => t.isRead)).toEqual([false, false]);
    expect(useFolderStore.getState().unreadCounts['a1__inbox']).toBe(3);
  });

  it('is a no-op when every thread already has the target state', async () => {
    useThreadStore.setState({ threads: [thread({ id: 't1', isRead: true })] });

    await useThreadStore.getState().markThreadsRead([thread({ id: 't1', isRead: true })], true);

    expect(getMessagesForThread).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts`
Expected: FAIL — `markThreadsRead is not a function`.

- [ ] **Step 3: Implement**

In `kylins.client.frontend/src/stores/threadStore.ts`, add to the `ThreadState` interface (after the `markThreadRead` line):

```ts
  markThreadsRead: (threads: Thread[], read: boolean) => Promise<void>;
```

Replace the existing `markThreadRead` implementation with a delegation plus the new bulk action:

```ts
  markThreadRead: async (thread, read, _messages) => {
    await get().markThreadsRead([thread], read);
  },

  markThreadsRead: async (threadsToMark, read) => {
    const targets = threadsToMark.filter((t) => t.isRead !== read);
    if (targets.length === 0) return;

    const msgsById = new Map<string, DbMessageRow[]>();
    await Promise.all(
      targets.map(async (t) => {
        msgsById.set(t.id, await getThreadMessages(t));
      }),
    );

    // One batched state update so a virtualized list re-renders once.
    const ids = new Set(targets.map((t) => t.id));
    set((s) => ({
      threads: s.threads.map((t) => (ids.has(t.id) ? { ...t, isRead: read } : t)),
    }));

    const labelId = get().currentQuery?.labelId;
    const folderStore = useFolderStore.getState();
    for (const t of targets) {
      const msgs = msgsById.get(t.id)!;
      void invoke('sync_apply_mutation', {
        accountId: t.accountId,
        op: {
          type: 'markRead',
          threadId: t.id,
          messageIds: msgs.map((m) => m.id),
          folderPath: msgs[0]?.imap_folder ?? '',
          uids: msgs.map((m) => m.imap_uid ?? 0),
          read,
        },
      }).catch((e) => console.error('sync_apply_mutation markRead failed', e));
      if (labelId) {
        if (read) folderStore.decrementUnread(t.accountId, labelId);
        else folderStore.incrementUnread(t.accountId, labelId);
      }
    }
  },
```

(`_messages` will trip `noUnusedParameters` ONLY if the tsconfig flags leading-underscore params — this project's other handlers use the same pattern; if `tsc` complains, drop the parameter name to `messages?: DbMessageRow[]` and reference it in a `void messages;` line. Prefer the underscore first.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts`
Expected: PASS (including the 3 pre-existing `markThreadRead` tests, which now exercise the delegation).

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/stores/threadStore.ts kylins.client.frontend/tests/stores/threadStore.test.ts
git commit -m "feat(frontend): bulk markThreadsRead in threadStore"
```

---
### Task 3: threadStore — bulk `setThreadsStarred`

**Files:**
- Modify: `kylins.client.frontend/src/stores/threadStore.ts`
- Test: `kylins.client.frontend/tests/stores/threadStore.test.ts`

**Interfaces:**
- Consumes: Task 1 store structure; `getThreadMessages`.
- Produces: `setThreadsStarred(threads: Thread[], starred: boolean): Promise<void>` — skips threads already in the target state; ONE batched `set()`; per target one `sync_apply_mutation` `setFlag` op (`flag: '\\Flagged'`, `add: starred`). `toggleThreadStarred(thread)` delegates with `!thread.isStarred`. (Refines the spec's `toggleThreadsStarred(threads)` name: the caller decides the direction from the anchor's state, so mixed selections converge instead of flipping.)

- [ ] **Step 1: Write the failing tests**

Append to `kylins.client.frontend/tests/stores/threadStore.test.ts`:

```ts
describe('threadStore.setThreadsStarred', () => {
  it('flags multiple threads with one setFlag op per thread', async () => {
    useThreadStore.setState({
      threads: [
        thread({ id: 't1', isStarred: false }),
        thread({ id: 't2', isStarred: false }),
        thread({ id: 't3', isStarred: true }),
      ],
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow()]);

    await useThreadStore.getState().setThreadsStarred(
      [
        thread({ id: 't1', isStarred: false }),
        thread({ id: 't2', isStarred: false }),
        thread({ id: 't3', isStarred: true }),
      ],
      true,
    );

    expect(useThreadStore.getState().threads.map((t) => t.isStarred)).toEqual([true, true, true]);
    // t3 was already flagged — no op for it.
    const flagOps = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'sync_apply_mutation' &&
          (args as { op: { type: string } }).op.type === 'setFlag',
      );
    expect(flagOps).toHaveLength(2);
    expect(flagOps[0]?.[1]).toEqual({
      accountId: 'a1',
      op: {
        type: 'setFlag',
        messageIds: ['m1'],
        folderPath: 'INBOX',
        uids: [4242],
        flag: '\\Flagged',
        add: true,
      },
    });
  });

  it('clears flags on multiple threads', async () => {
    useThreadStore.setState({
      threads: [thread({ id: 't1', isStarred: true }), thread({ id: 't2', isStarred: true })],
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow()]);

    await useThreadStore.getState().setThreadsStarred(
      [thread({ id: 't1', isStarred: true }), thread({ id: 't2', isStarred: true })],
      false,
    );

    expect(useThreadStore.getState().threads.map((t) => t.isStarred)).toEqual([false, false]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts`
Expected: FAIL — `setThreadsStarred is not a function`.

- [ ] **Step 3: Implement**

In `kylins.client.frontend/src/stores/threadStore.ts`, add to the `ThreadState` interface (after the `toggleThreadStarred` line):

```ts
  setThreadsStarred: (threads: Thread[], starred: boolean) => Promise<void>;
```

Replace the existing `toggleThreadStarred` implementation with a delegation plus the new bulk action:

```ts
  toggleThreadStarred: async (thread, _messages) => {
    await get().setThreadsStarred([thread], !thread.isStarred);
  },

  setThreadsStarred: async (threadsToFlag, starred) => {
    const targets = threadsToFlag.filter((t) => t.isStarred !== starred);
    if (targets.length === 0) return;

    const msgsById = new Map<string, DbMessageRow[]>();
    await Promise.all(
      targets.map(async (t) => {
        msgsById.set(t.id, await getThreadMessages(t));
      }),
    );

    const ids = new Set(targets.map((t) => t.id));
    set((s) => ({
      threads: s.threads.map((t) => (ids.has(t.id) ? { ...t, isStarred: starred } : t)),
    }));

    for (const t of targets) {
      const msgs = msgsById.get(t.id)!;
      void invoke('sync_apply_mutation', {
        accountId: t.accountId,
        op: {
          type: 'setFlag',
          messageIds: msgs.map((m) => m.id),
          folderPath: msgs[0]?.imap_folder ?? '',
          uids: msgs.map((m) => m.imap_uid ?? 0),
          flag: '\\Flagged',
          add: starred,
        },
      }).catch((e) => console.error('sync_apply_mutation setFlag failed', e));
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts`
Expected: PASS (including the 2 pre-existing `toggleThreadStarred` tests via the delegation).

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/stores/threadStore.ts kylins.client.frontend/tests/stores/threadStore.test.ts
git commit -m "feat(frontend): bulk setThreadsStarred in threadStore"
```

---

### Task 4: threadStore — bulk `deleteThreads`

**Files:**
- Modify: `kylins.client.frontend/src/stores/threadStore.ts`
- Test: `kylins.client.frontend/tests/stores/threadStore.test.ts`

**Interfaces:**
- Consumes: Task 1's `openThreadBody` closure and selection fields.
- Produces: `deleteThreads(threads: Thread[]): Promise<void>` — removes all given threads in ONE `set()`; if the anchor was removed, the anchor moves to the next remaining thread after the anchor's old position (falling back to the previous remaining thread, else null) and its body is loaded via `openThreadBody`; otherwise the anchor stays and the selection is pruned. Decrements the folder unread count once per removed unread thread (only when `currentQuery.labelId` is set). Per removed thread: one `sync_apply_mutation` `delete` op and one `thread:deleted` event emit (the emit only fires when `__TAURI_INTERNALS__` is present, so jsdom tests skip it). `deleteThread(thread)` delegates.

- [ ] **Step 1: Write the failing tests**

Append to `kylins.client.frontend/tests/stores/threadStore.test.ts`:

```ts
describe('threadStore.deleteThreads', () => {
  it('removes multiple threads, moves the anchor past the removed block, and adjusts counts', async () => {
    useThreadStore.setState({
      threads: [
        thread({ id: 't1', isRead: false }),
        thread({ id: 't2', isRead: false }),
        thread({ id: 't3', isRead: true }),
      ],
      selectedThreadId: 't1',
      selectedThreadIds: ['t1', 't2'],
      selectionAnchorId: 't1',
      currentQuery: { accountId: 'a1', labelId: 'inbox' },
    });
    useFolderStore.setState({ unreadCounts: { a1__inbox: 4 } });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow({ thread_id: 't3' })]);
    vi.mocked(getMessageBody).mockResolvedValue(null);

    await useThreadStore.getState().deleteThreads([
      thread({ id: 't1', isRead: false }),
      thread({ id: 't2', isRead: false }),
    ]);

    const s = useThreadStore.getState();
    expect(s.threads.map((t) => t.id)).toEqual(['t3']);
    expect(s.selectedThreadId).toBe('t3');
    expect(s.selectedThreadIds).toEqual(['t3']);
    expect(s.selectionAnchorId).toBe('t3');
    expect(useViewStore.getState().selectedMessage?.threadId).toBe('t3');
    expect(useFolderStore.getState().unreadCounts['a1__inbox']).toBe(2);
    const deleteOps = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'sync_apply_mutation' &&
          (args as { op: { type: string } }).op.type === 'delete',
      );
    expect(deleteOps).toHaveLength(2);
  });

  it('keeps the anchor and prunes the selection when a non-anchor thread is deleted', async () => {
    useThreadStore.setState({
      threads: [thread({ id: 't1', isRead: true }), thread({ id: 't2', isRead: true })],
      selectedThreadId: 't1',
      selectedThreadIds: ['t1', 't2'],
      selectionAnchorId: 't1',
      currentQuery: { accountId: 'a1', labelId: 'inbox' },
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow({ thread_id: 't2' })]);

    await useThreadStore.getState().deleteThreads([thread({ id: 't2', isRead: true })]);

    const s = useThreadStore.getState();
    expect(s.threads.map((t) => t.id)).toEqual(['t1']);
    expect(s.selectedThreadId).toBe('t1');
    expect(s.selectedThreadIds).toEqual(['t1']);
    // The anchor's body is NOT reloaded — only the delete op fetched messages.
    expect(getMessagesForThread).toHaveBeenCalledTimes(1);
    expect(getMessagesForThread).toHaveBeenCalledWith('a1', 't2');
  });

  it('clears the selection when the last selected thread is deleted', async () => {
    useThreadStore.setState({
      threads: [thread({ id: 't1', isRead: true })],
      selectedThreadId: 't1',
      selectedThreadIds: ['t1'],
      selectionAnchorId: 't1',
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow()]);

    await useThreadStore.getState().deleteThreads([thread({ id: 't1', isRead: true })]);

    const s = useThreadStore.getState();
    expect(s.threads).toEqual([]);
    expect(s.selectedThreadId).toBeNull();
    expect(s.selectedThreadIds).toEqual([]);
    expect(useViewStore.getState().selectedMessage).toBeNull();
    expect(useViewStore.getState().selectedThreadIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts`
Expected: FAIL — `deleteThreads is not a function`.

- [ ] **Step 3: Implement**

In `kylins.client.frontend/src/stores/threadStore.ts`, add to the `ThreadState` interface (after the `deleteThread` line):

```ts
  deleteThreads: (threads: Thread[]) => Promise<void>;
```

Replace the entire existing `deleteThread` implementation (including the Task-1 stopgap `setSelectedThreadIds` line) with:

```ts
  deleteThread: async (thread, _messages) => {
    await get().deleteThreads([thread]);
  },

  deleteThreads: async (threadsToDelete) => {
    if (threadsToDelete.length === 0) return;
    const state = get();
    const removedIds = new Set(threadsToDelete.map((t) => t.id));
    const remaining = state.threads.filter((t) => !removedIds.has(t.id));

    // Anchor re-selection: if the anchor was removed, move to the next
    // remaining thread after the anchor's old position (falling back to the
    // previous remaining thread), matching the legacy single-delete behavior.
    const anchorRemoved =
      state.selectedThreadId != null && removedIds.has(state.selectedThreadId);
    let nextAnchorId: string | null = state.selectedThreadId;
    if (anchorRemoved) {
      const anchorIdx = state.threads.findIndex((t) => t.id === state.selectedThreadId);
      nextAnchorId =
        state.threads
          .slice(anchorIdx + 1)
          .find((t) => !removedIds.has(t.id))?.id ??
        state.threads
          .slice(0, Math.max(anchorIdx, 0))
          .reverse()
          .find((t) => !removedIds.has(t.id))?.id ??
        null;
    }
    const nextSelection = nextAnchorId ? [nextAnchorId] : [];

    set({
      threads: remaining,
      selectedThreadIds: nextSelection,
      selectionAnchorId: nextAnchorId,
      selectedThreadId: nextAnchorId,
    });
    useViewStore.getState().setSelectedThreadIds(nextSelection);

    const labelId = state.currentQuery?.labelId;
    const folderStore = useFolderStore.getState();
    for (const t of threadsToDelete) {
      if (labelId && !t.isRead) folderStore.decrementUnread(t.accountId, labelId);
    }

    // Repoint the reading pane.
    if (anchorRemoved) {
      const next = nextAnchorId ? remaining.find((t) => t.id === nextAnchorId) : undefined;
      if (next) {
        await openThreadBody(next);
      } else {
        useViewStore.getState().setSelectedMessage(null);
      }
    } else if (
      threadsToDelete.some((t) => t.id === useViewStore.getState().selectedMessage?.threadId)
    ) {
      useViewStore.getState().setSelectedMessage(null);
    }

    for (const t of threadsToDelete) {
      const msgs = await getThreadMessages(t);
      void invoke('sync_apply_mutation', {
        accountId: t.accountId,
        op: {
          type: 'delete',
          messageIds: msgs.map((m) => m.id),
          folderPath: msgs[0]?.imap_folder ?? '',
          uids: msgs.map((m) => m.imap_uid ?? 0),
        },
      }).catch((e) => console.error('sync_apply_mutation delete failed', e));

      // Notify other windows (e.g., standalone message viewers) that this
      // thread is gone so they can close instead of showing stale content.
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { emit } = await import('@tauri-apps/api/event');
        void emit('thread:deleted', { accountId: t.accountId, threadId: t.id });
      }
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts`
Expected: PASS (including the pre-existing `deleteThread` test via the delegation).

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/stores/threadStore.ts kylins.client.frontend/tests/stores/threadStore.test.ts
git commit -m "feat(frontend): bulk deleteThreads in threadStore"
```

---
### Task 5: threadStore — bulk `moveThreads` / `moveThreadsToRole` + `archiveThreads` action

**Files:**
- Modify: `kylins.client.frontend/src/stores/threadStore.ts`
- Modify: `kylins.client.frontend/src/services/mail/actions.ts`
- Test: `kylins.client.frontend/tests/stores/threadStore.test.ts`

**Interfaces:**
- Consumes: Task 1's `openThreadBody`; `getFolderByRole` from `src/services/db/labels`; `FolderRole` type.
- Produces:
  - `moveThreads(threads: Thread[], dstLabel: string, dstFolderPath: string): Promise<void>` — same removal/anchor/unread-count semantics as `deleteThreads` (Task 4), but emits one `sync_apply_mutation` `move` op per thread (with per-thread `srcLabel`/`srcFolderPath` resolution) and no `thread:deleted` event.
  - `moveThreadsToRole(threads: Thread[], role: FolderRole): Promise<void>` — groups threads by `accountId`, resolves the role folder once per account via `getFolderByRole`, and calls `moveThreads` per group (logs + skips accounts with no such folder).
  - `moveThread(thread, dstLabel, dstFolderPath)` and `moveThreadToRole(thread, role)` delegate.
  - `archiveThreads(threads: Thread[]): Promise<void>` in `src/services/mail/actions.ts` — calls `moveThreadsToRole(threads, 'archive')`. Used by Task 8's context menu.

- [ ] **Step 1: Add the labels mock and write the failing tests**

In `kylins.client.frontend/tests/stores/threadStore.test.ts`, add a mock near the other `vi.mock` blocks (after the cryptoReceive mock):

```ts
vi.mock('../../src/services/db/labels', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/db/labels')>(
    '../../src/services/db/labels',
  );
  return { ...actual, getFolderByRole: vi.fn() };
});
```

Add to the imports at the top of the file:

```ts
import { getFolderByRole } from '../../src/services/db/labels';
import type { MailFolder } from '../../src/services/mail/folders/folderModel';
```

In `beforeEach`, add:

```ts
  vi.mocked(getFolderByRole).mockReset();
```

Append the tests:

```ts
describe('threadStore.moveThreads', () => {
  it('moves multiple threads with one move op per thread', async () => {
    useThreadStore.setState({
      threads: [
        thread({ id: 't1', isRead: false }),
        thread({ id: 't2', isRead: false }),
        thread({ id: 't3', isRead: true }),
      ],
      selectedThreadId: 't1',
      selectedThreadIds: ['t1', 't2'],
      selectionAnchorId: 't1',
      currentQuery: { accountId: 'a1', labelId: 'inbox' },
    });
    useFolderStore.setState({
      selected: { accountId: 'a1', labelId: 'inbox' },
      unreadCounts: { a1__inbox: 2 },
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow()]);
    vi.mocked(getMessageBody).mockResolvedValue(null);

    await useThreadStore.getState().moveThreads(
      [thread({ id: 't1', isRead: false }), thread({ id: 't2', isRead: false })],
      'archive-id',
      'Archive',
    );

    const s = useThreadStore.getState();
    expect(s.threads.map((t) => t.id)).toEqual(['t3']);
    expect(s.selectedThreadId).toBe('t3');
    const moveOps = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'sync_apply_mutation' &&
          (args as { op: { type: string } }).op.type === 'move',
      );
    expect(moveOps).toHaveLength(2);
    expect(moveOps[0]?.[1]).toEqual({
      accountId: 'a1',
      op: {
        type: 'move',
        messageIds: ['m1'],
        srcLabel: 'inbox',
        dstLabel: 'archive-id',
        srcFolderPath: 'INBOX',
        dstFolderPath: 'Archive',
        uids: [4242],
      },
    });
    expect(useFolderStore.getState().unreadCounts['a1__inbox']).toBe(0);
  });
});

describe('threadStore.moveThreadsToRole', () => {
  it('resolves the role folder per account and moves the group', async () => {
    useThreadStore.setState({
      threads: [thread({ id: 't1', isRead: true })],
      selectedThreadId: 't1',
      selectedThreadIds: ['t1'],
      selectionAnchorId: 't1',
      currentQuery: { accountId: 'a1', labelId: 'inbox' },
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    vi.mocked(getMessagesForThread).mockResolvedValue([messageRow()]);
    vi.mocked(getFolderByRole).mockResolvedValue({
      id: 'arch',
      accountId: 'a1',
      name: 'Archive',
      remoteId: 'Archive',
      role: 'archive',
    } as MailFolder);

    await useThreadStore.getState().moveThreadsToRole([thread({ id: 't1', isRead: true })], 'archive');

    expect(getFolderByRole).toHaveBeenCalledWith('a1', 'archive');
    const moveOps = vi
      .mocked(invoke)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'sync_apply_mutation' &&
          (args as { op: { type: string } }).op.type === 'move',
      );
    expect(moveOps).toHaveLength(1);
    expect(moveOps[0]?.[1]).toEqual(
      expect.objectContaining({
        op: expect.objectContaining({ type: 'move', dstLabel: 'arch', dstFolderPath: 'Archive' }),
      }),
    );
    expect(useThreadStore.getState().threads).toHaveLength(0);
  });

  it('logs and skips when the account has no folder for the role', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    useThreadStore.setState({ threads: [thread({ id: 't1' })] });
    vi.mocked(getFolderByRole).mockResolvedValue(null);

    await useThreadStore.getState().moveThreadsToRole([thread({ id: 't1' })], 'archive');

    expect(useThreadStore.getState().threads).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts`
Expected: FAIL — `moveThreads is not a function` / `moveThreadsToRole is not a function`.

- [ ] **Step 3: Implement**

In `kylins.client.frontend/src/stores/threadStore.ts`:

**3a.** Add a module-level helper below `getThreadMessages`:

```ts
/**
 * Resolve the source label/folder for a move op. The folder pane selection is
 * the authoritative source when it matches the thread's account; otherwise
 * fall back to the message's IMAP folder path.
 */
function resolveMoveSource(thread: Thread, msgs: DbMessageRow[]): {
  srcLabel: string | null;
  srcFolderPath: string;
} {
  const selected = useFolderStore.getState().selected;
  let srcLabel = selected?.accountId === thread.accountId ? selected.labelId : null;
  const srcFolderPath = msgs[0]?.imap_folder ?? '';
  if (!srcLabel && srcFolderPath) {
    const folder = useFolderStore
      .getState()
      .byAccount[thread.accountId]?.find(
        (f) => f.remoteId === srcFolderPath || f.name === srcFolderPath,
      );
    srcLabel = folder?.id ?? null;
  }
  return { srcLabel, srcFolderPath };
}
```

**3b.** Add to the `ThreadState` interface (after the `moveThread` line):

```ts
  moveThreads: (threads: Thread[], dstLabel: string, dstFolderPath: string) => Promise<void>;
  moveThreadsToRole: (threads: Thread[], role: FolderRole) => Promise<void>;
```

**3c.** Replace the entire existing `moveThread` and `moveThreadToRole` implementations with:

```ts
  moveThread: async (thread, dstLabel, dstFolderPath, _messages) => {
    await get().moveThreads([thread], dstLabel, dstFolderPath);
  },

  moveThreads: async (threadsToMove, dstLabel, dstFolderPath) => {
    if (threadsToMove.length === 0) return;
    const state = get();
    const removedIds = new Set(threadsToMove.map((t) => t.id));
    const remaining = state.threads.filter((t) => !removedIds.has(t.id));

    const anchorRemoved =
      state.selectedThreadId != null && removedIds.has(state.selectedThreadId);
    let nextAnchorId: string | null = state.selectedThreadId;
    if (anchorRemoved) {
      const anchorIdx = state.threads.findIndex((t) => t.id === state.selectedThreadId);
      nextAnchorId =
        state.threads
          .slice(anchorIdx + 1)
          .find((t) => !removedIds.has(t.id))?.id ??
        state.threads
          .slice(0, Math.max(anchorIdx, 0))
          .reverse()
          .find((t) => !removedIds.has(t.id))?.id ??
        null;
    }
    const nextSelection = nextAnchorId ? [nextAnchorId] : [];

    set({
      threads: remaining,
      selectedThreadIds: nextSelection,
      selectionAnchorId: nextAnchorId,
      selectedThreadId: nextAnchorId,
    });
    useViewStore.getState().setSelectedThreadIds(nextSelection);

    const labelId = state.currentQuery?.labelId;
    const folderStore = useFolderStore.getState();
    for (const t of threadsToMove) {
      if (labelId && !t.isRead) folderStore.decrementUnread(t.accountId, labelId);
    }

    if (anchorRemoved) {
      const next = nextAnchorId ? remaining.find((t) => t.id === nextAnchorId) : undefined;
      if (next) {
        await openThreadBody(next);
      } else {
        useViewStore.getState().setSelectedMessage(null);
      }
    } else if (
      threadsToMove.some((t) => t.id === useViewStore.getState().selectedMessage?.threadId)
    ) {
      useViewStore.getState().setSelectedMessage(null);
    }

    for (const t of threadsToMove) {
      const msgs = await getThreadMessages(t);
      const { srcLabel, srcFolderPath } = resolveMoveSource(t, msgs);
      void invoke('sync_apply_mutation', {
        accountId: t.accountId,
        op: {
          type: 'move',
          messageIds: msgs.map((m) => m.id),
          srcLabel: srcLabel ?? '',
          dstLabel,
          srcFolderPath,
          dstFolderPath,
          uids: msgs.map((m) => m.imap_uid ?? 0),
        },
      }).catch((e) => console.error('sync_apply_mutation move failed', e));
    }
  },

  moveThreadToRole: async (thread, role, _messages) => {
    await get().moveThreadsToRole([thread], role);
  },

  moveThreadsToRole: async (threadsToMove, role) => {
    const byAccount = new Map<string, Thread[]>();
    for (const t of threadsToMove) {
      const group = byAccount.get(t.accountId) ?? [];
      group.push(t);
      byAccount.set(t.accountId, group);
    }
    for (const [accountId, group] of byAccount) {
      const folder = await getFolderByRole(accountId, role);
      if (!folder) {
        console.error(`[threadStore] no ${role} folder for account ${accountId}`);
        continue;
      }
      await get().moveThreads(group, folder.id, folder.remoteId);
    }
  },
```

**3d.** In `kylins.client.frontend/src/services/mail/actions.ts`, add:

```ts
export async function archiveThreads(threads: Thread[]): Promise<void> {
  await useThreadStore.getState().moveThreadsToRole(threads, 'archive');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/threadStore.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/stores/threadStore.ts kylins.client.frontend/src/services/mail/actions.ts kylins.client.frontend/tests/stores/threadStore.test.ts
git commit -m "feat(frontend): bulk moveThreads/moveThreadsToRole + archiveThreads action"
```

---

### Task 6: MessageList — modifier clicks, right-click behavior, aria

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/MessageList.tsx`
- Test: `kylins.client.frontend/tests/components/layout/MessageList.test.tsx`

**Interfaces:**
- Consumes: Task 1's `selectedThreadIds`, `selectionAnchorId`, `setSelection`, `selectThread`.
- Produces (used by Tasks 7-8):
  - Component-scope `rangeIds(fromId: string, toId: string): string[]` — thread-id range over `filteredItems`, skipping `kind: 'group'` headers.
  - `selectedIdSet: Set<string>` memo.
  - `menu` state shape becomes `{ thread: Thread; targets: Thread[]; x: number; y: number } | null` (targets wired up in Task 8).
  - `handleRowClick(thread: Thread, e: React.MouseEvent): void`.

- [ ] **Step 1: Update the test setup and write the failing tests**

In `kylins.client.frontend/tests/components/layout/MessageList.test.tsx`, update the `useThreadStore.setState` call in `beforeEach` to include the new fields:

```ts
  useThreadStore.setState({
    threads: [],
    selectedThreadId: null,
    selectedThreadIds: [],
    selectionAnchorId: null,
    isLoading: false,
    cursor: null,
    currentQuery: null,
  });
```

Append inside the top-level `describe('MessageList', ...)`:

```tsx
  it('exposes aria-multiselectable on the listbox', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' })],
      nextCursor: null,
    });
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
  });

  it('ctrl+click toggles rows in and out of the selection', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' }), thread({ id: 't2', subject: 'World' })],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Hello'));
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']),
    );

    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']),
    );
    // The ctrl-clicked-in row becomes the anchor (reading-pane target).
    expect(useThreadStore.getState().selectedThreadId).toBe('t2');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    // Ctrl+click the anchor again: toggled out, anchor falls back to t1.
    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']),
    );
    expect(useThreadStore.getState().selectedThreadId).toBe('t1');
  });

  it('shift+click selects the range from the anchor', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']),
    );

    fireEvent.click(screen.getByText('Three'), { shiftKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2', 't3']),
    );
    // The anchor does not move on shift+click.
    expect(useThreadStore.getState().selectionAnchorId).toBe('t1');
  });

  it('plain click collapses a multi-selection', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    fireEvent.click(screen.getByText('Two'), { ctrlKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']),
    );

    fireEvent.click(screen.getByText('Three'));
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t3']),
    );
  });

  it('right-click on a selected row keeps the multi-selection', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' }), thread({ id: 't2', subject: 'World' })],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Hello'));
    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']),
    );

    fireEvent.contextMenu(screen.getByText('World'));
    expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']);
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
  });

  it('right-click on an unselected row collapses to that row first', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']),
    );

    fireEvent.contextMenu(screen.getByText('Three'));
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t3']),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/components/layout/MessageList.test.tsx`
Expected: FAIL — `aria-multiselectable` missing; ctrl/shift clicks behave as plain clicks; right-click keeps single-selection behavior.

- [ ] **Step 3: Implement**

In `kylins.client.frontend/src/components/layout/MessageList.tsx`:

**3a.** `MessageRowProps` — change the click signature so the row receives the mouse event:

```ts
interface MessageRowProps {
  thread: Thread;
  selected?: boolean;
  density: 'compact' | 'normal' | 'comfortable';
  visibleColumns: ColumnDef[];
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}
```

(`MessageRow` spreads `...handlers` onto the row div, so no change needed inside `MessageRow`.)

**3b.** In `MessageList`, add store subscriptions next to the existing ones:

```ts
  const selectedThreadIds = useThreadStore((s) => s.selectedThreadIds);
  const selectionAnchorId = useThreadStore((s) => s.selectionAnchorId);
  const setSelection = useThreadStore((s) => s.setSelection);
```

**3c.** Below the `filteredItems` memo, add:

```ts
  const selectedIdSet = useMemo(() => new Set(selectedThreadIds), [selectedThreadIds]);

  // Thread-id range between two rows over the FILTERED list, skipping group
  // headers. Falls back to just the target when either end scrolled out of
  // the loaded pages.
  const rangeIds = (fromId: string, toId: string): string[] => {
    const idxOf = (id: string) =>
      filteredItems.findIndex((it) => it.kind === 'thread' && it.thread.id === id);
    const a = idxOf(fromId);
    const b = idxOf(toId);
    if (a === -1 || b === -1) return [toId];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return filteredItems
      .slice(lo, hi + 1)
      .flatMap((it) => (it.kind === 'thread' ? [it.thread.id] : []));
  };

  const handleRowClick = (t: Thread, e: React.MouseEvent) => {
    setActiveDescendantId(optionId(t.id));
    if (e.shiftKey && selectionAnchorId) {
      void setSelection(rangeIds(selectionAnchorId, t.id), selectionAnchorId);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedThreadIds);
      let nextAnchor = selectionAnchorId;
      if (next.has(t.id)) {
        next.delete(t.id);
        if (nextAnchor === t.id) nextAnchor = [...next].at(-1) ?? null;
      } else {
        next.add(t.id);
        nextAnchor = t.id;
      }
      void setSelection([...next], nextAnchor);
      return;
    }
    void selectThread(t);
  };
```

(`setActiveDescendantId` is declared later in the file today — move the `const [activeDescendantId, setActiveDescendantId] = useState<string | null>(null);` declaration above `filteredItems` if the compiler flags use-before-declaration; it is only referenced inside handlers, so it is safe either way.)

**3d.** Update `openContextMenu` and the `menu` state:

```ts
  const [menu, setMenu] = useState<{
    thread: Thread;
    targets: Thread[];
    x: number;
    y: number;
  } | null>(null);
```

```ts
  const openContextMenu = (thread: Thread, e: React.MouseEvent) => {
    e.preventDefault();
    setActiveDescendantId(optionId(thread.id));
    // Outlook behavior: right-click on a row inside a multi-selection targets
    // the whole selection; right-click elsewhere collapses to that row first.
    const keepSelection = selectedIdSet.has(thread.id) && selectedThreadIds.length > 1;
    if (!keepSelection) {
      void selectThread(thread);
    }
    const targets = keepSelection
      ? threads.filter((t) => selectedIdSet.has(t.id))
      : [thread];
    setMenu({ thread, targets, x: e.clientX, y: e.clientY });
  };
```

**3e.** Row render — pass membership + the event-bearing click handler:

```tsx
                    <MessageRow
                      thread={item.thread}
                      selected={selectedIdSet.has(item.thread.id)}
                      density={density}
                      visibleColumns={visibleColumns}
                      onClick={(e) => handleRowClick(item.thread, e)}
                      onDoubleClick={() => void handleDoubleClick(item.thread)}
                      onContextMenu={(e) => openContextMenu(item.thread, e)}
                    />
```

**3f.** Listbox aria — add `aria-multiselectable`:

```tsx
        role="listbox"
        aria-label="Messages"
        aria-multiselectable="true"
```

(The `menuItems` useMemo still references `menu.thread` — it keeps compiling because `thread` remains on the menu state; Task 8 rewrites it to use `targets`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/components/layout/MessageList.test.tsx && npx tsc --noEmit`
Expected: PASS (all existing + 6 new), no type errors.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/layout/MessageList.tsx kylins.client.frontend/tests/components/layout/MessageList.test.tsx
git commit -m "feat(frontend): ctrl/shift click multi-select in message list"
```

---
### Task 7: MessageList — keyboard (Ctrl+A, Shift+Arrow)

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/MessageList.tsx`
- Test: `kylins.client.frontend/tests/components/layout/MessageList.test.tsx`

**Interfaces:**
- Consumes: Task 6's `rangeIds`, `selectedIdSet`, `setSelection`, `selectionAnchorId`.
- Produces: extended listbox `onKeyDown` — Ctrl/Cmd+A selects all loaded threads; Shift+Arrow extends/shrinks the range around the anchor (the moving edge is `activeDescendantId` when it is in the selection, else the anchor); plain Arrow keeps today's collapse-and-move behavior.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('MessageList', ...)` in `kylins.client.frontend/tests/components/layout/MessageList.test.tsx`:

```tsx
  it('ctrl+A selects all loaded threads', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'a', ctrlKey: true });

    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2', 't3']),
    );
    // No prior anchor — falls back to the first row.
    expect(useThreadStore.getState().selectionAnchorId).toBe('t1');
  });

  it('shift+arrow extends and shrinks the selection from the anchor', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1']),
    );

    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']),
    );

    fireEvent.keyDown(listbox, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2', 't3']),
    );
    // Anchor fixed; reading pane keeps showing the anchor.
    expect(useThreadStore.getState().selectionAnchorId).toBe('t1');
    expect(useThreadStore.getState().selectedThreadId).toBe('t1');

    fireEvent.keyDown(listbox, { key: 'ArrowUp', shiftKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']),
    );
  });

  it('plain arrow collapses the selection to the next single row', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'One' }),
        thread({ id: 't2', subject: 'Two' }),
        thread({ id: 't3', subject: 'Three' }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());

    fireEvent.click(screen.getByText('One'));
    fireEvent.click(screen.getByText('Two'), { ctrlKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']),
    );

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t3']),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/components/layout/MessageList.test.tsx`
Expected: FAIL — Ctrl+A and Shift+Arrow are unhandled (Ctrl+A test: nothing selected; Shift+Arrow: behaves like plain arrow).

- [ ] **Step 3: Implement**

In `kylins.client.frontend/src/components/layout/MessageList.tsx`, replace the entire listbox `onKeyDown` handler with:

```tsx
        onKeyDown={(e) => {
          // Ctrl/Cmd+A — select every loaded thread (group headers excluded).
          if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            const allIds = filteredItems.flatMap((it) =>
              it.kind === 'thread' ? [it.thread.id] : [],
            );
            if (allIds.length === 0) return;
            const anchor =
              selectionAnchorId && allIds.includes(selectionAnchorId)
                ? selectionAnchorId
                : allIds[0]!;
            setActiveDescendantId(optionId(anchor));
            void setSelection(allIds, anchor);
            return;
          }

          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const direction = e.key === 'ArrowDown' ? 1 : -1;
            // In shift mode the moving edge is the active descendant when it
            // is part of the selection; otherwise the anchor. This lets a
            // range grow AND shrink around a fixed anchor.
            const edgeId = activeDescendantId?.replace(/^message-option-/, '') ?? null;
            const baseId =
              e.shiftKey && edgeId && selectedIdSet.has(edgeId) ? edgeId : selectedThreadId;
            const currentIndex = filteredItems.findIndex(
              (i) => i.kind === 'thread' && i.thread.id === baseId,
            );
            function nextThreadIndex(start: number, dir: 1 | -1): number | null {
              let i = start + dir;
              while (i >= 0 && i < filteredItems.length) {
                if (filteredItems[i]?.kind === 'thread') return i;
                i += dir;
              }
              return null;
            }
            const nextIndex =
              currentIndex === -1
                ? nextThreadIndex(direction === 1 ? -1 : filteredItems.length, direction)
                : nextThreadIndex(currentIndex, direction);
            if (nextIndex == null) return;
            const nextItem = filteredItems[nextIndex];
            if (!nextItem || nextItem.kind !== 'thread') return;
            setActiveDescendantId(optionId(nextItem.thread.id));
            if (e.shiftKey && selectionAnchorId) {
              void setSelection(rangeIds(selectionAnchorId, nextItem.thread.id), selectionAnchorId);
            } else {
              void selectThread(nextItem.thread);
            }
            virtualizer.scrollToIndex(nextIndex, { align: 'auto' });
            return;
          }

          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const activeThreadId = activeDescendantId?.replace(/^message-option-/, '');
            const activeItem = activeThreadId
              ? filteredItems.find((i) => i.kind === 'thread' && i.thread.id === activeThreadId)
              : undefined;
            if (activeItem?.kind === 'thread') {
              void selectThread(activeItem.thread);
            }
          }
        }}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/components/layout/MessageList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add kylins.client.frontend/src/components/layout/MessageList.tsx kylins.client.frontend/tests/components/layout/MessageList.test.tsx
git commit -m "feat(frontend): ctrl+a and shift+arrow keyboard multi-select"
```

---

### Task 8: MessageList — bulk context-menu actions

**Files:**
- Modify: `kylins.client.frontend/src/components/layout/MessageList.tsx`
- Test: `kylins.client.frontend/tests/components/layout/MessageList.test.tsx`

**Interfaces:**
- Consumes: `markThreadsRead`, `setThreadsStarred`, `deleteThreads`, `moveThreads` (Tasks 2-5); `archiveThreads` from `src/services/mail/actions` (Task 5); Task 6's `menu.targets`.
- Produces: context menu where Mark Read/Unread, Follow Up, Move, Delete, Archive act on `menu.targets`; when `targets.length > 1` the labels are exactly:
  - `Mark {n} as Read` / `Mark {n} as Unread` (direction from the right-clicked thread's `isRead`)
  - `Follow up {n} conversations` / `Clear follow up on {n} conversations` (direction from the right-clicked thread's `isStarred`)
  - `Move {n} conversations…`
  - `Delete {n} conversations`
  - `Archive {n} conversations`
  Single-selection labels stay exactly as today (`Mark as Read`, `Follow Up`, `Move`, `Delete`, `Archive`). Reply/Reply All/Forward stay single (right-clicked thread). `moveMenu` state becomes `{ threads: Thread[]; x: number; y: number } | null`.

- [ ] **Step 1: Update existing tests and write the failing bulk tests**

In `kylins.client.frontend/tests/components/layout/MessageList.test.tsx`, four existing tests spy on single-thread actions that are being replaced by bulk calls. Update them:

**1a.** In `marks a thread as unread from the context menu`, replace the spy + assertion:

```tsx
    const markThreadsRead = vi.spyOn(useThreadStore.getState(), 'markThreadsRead');
```

```tsx
    expect(markThreadsRead).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 't1', isRead: true })],
      false,
    );
    markThreadsRead.mockRestore();
```

**1b.** In `deletes a thread from the context menu`, replace the spy + assertion:

```tsx
    const deleteThreads = vi.spyOn(useThreadStore.getState(), 'deleteThreads');
```

```tsx
    expect(deleteThreads).toHaveBeenCalledWith([expect.objectContaining({ id: 't1' })]);
    deleteThreads.mockRestore();
```

**1c.** In `archives a thread from the context menu`, replace the spy + assertion:

```tsx
    const archiveThreads = vi.spyOn(
      await import('../../../src/services/mail/actions'),
      'archiveThreads',
    );
```

```tsx
    expect(archiveThreads).toHaveBeenCalledWith([expect.objectContaining({ id: 't1' })]);
    archiveThreads.mockRestore();
```

**1d.** In `toggles the star / follow-up flag from the context menu`, replace the spy + assertion:

```tsx
    const setThreadsStarred = vi.spyOn(useThreadStore.getState(), 'setThreadsStarred');
```

```tsx
    expect(setThreadsStarred).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 't1' })],
      true,
    );
    setThreadsStarred.mockRestore();
```

**1e.** Append the bulk tests inside `describe('MessageList', ...)`:

```tsx
  it('shows count labels and applies Delete to the whole multi-selection', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [thread({ id: 't1', subject: 'Hello' }), thread({ id: 't2', subject: 'World' })],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Hello'));
    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']),
    );

    fireEvent.contextMenu(screen.getByText('World'));
    expect(screen.getByRole('menuitem', { name: 'Delete 2 conversations' })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Archive 2 conversations' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Mark 2 as Read' })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Follow up 2 conversations' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Move 2 conversations…' }),
    ).toBeInTheDocument();

    const deleteThreads = vi.spyOn(useThreadStore.getState(), 'deleteThreads');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete 2 conversations' }));
    expect(deleteThreads).toHaveBeenCalledWith([
      expect.objectContaining({ id: 't1' }),
      expect.objectContaining({ id: 't2' }),
    ]);
    deleteThreads.mockRestore();
  });

  it('applies Mark as Unread to the whole multi-selection following the clicked row', async () => {
    vi.mocked(getThreads).mockResolvedValue({
      threads: [
        thread({ id: 't1', subject: 'Hello', isRead: true }),
        thread({ id: 't2', subject: 'World', isRead: false }),
      ],
      nextCursor: null,
    });
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useFolderStore.setState({ selected: { accountId: 'a1', labelId: 'inbox' } });
    render(<MessageList />);
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Hello'));
    fireEvent.click(screen.getByText('World'), { ctrlKey: true });
    await waitFor(() =>
      expect(useThreadStore.getState().selectedThreadIds).toEqual(['t1', 't2']),
    );

    fireEvent.contextMenu(screen.getByText('Hello'));
    const markThreadsRead = vi.spyOn(useThreadStore.getState(), 'markThreadsRead');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark 2 as Unread' }));
    expect(markThreadsRead).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 't1' }), expect.objectContaining({ id: 't2' })],
      false,
    );
    markThreadsRead.mockRestore();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/components/layout/MessageList.test.tsx`
Expected: FAIL — the updated spies never fire (menu still calls single actions); count labels don't exist.

- [ ] **Step 3: Implement**

In `kylins.client.frontend/src/components/layout/MessageList.tsx`:

**3a.** Add the bulk store actions to the subscriptions:

```ts
  const markThreadsRead = useThreadStore((s) => s.markThreadsRead);
  const setThreadsStarred = useThreadStore((s) => s.setThreadsStarred);
  const deleteThreads = useThreadStore((s) => s.deleteThreads);
  const moveThreads = useThreadStore((s) => s.moveThreads);
```

(Remove the now-unused `markThreadRead`, `toggleThreadStarred`, `deleteThread`, `moveThread` subscriptions in this component — `MessageRow` uses its own `markThreadRead`/`toggleThreadStarred` subscriptions for the colorbar/flag buttons, which stay.)

**3b.** Update the import from mail actions:

```ts
import { archiveThread, archiveThreads, trashThread } from '../../services/mail/actions';
```

**3c.** Update `moveMenu` state:

```ts
  const [moveMenu, setMoveMenu] = useState<{ threads: Thread[]; x: number; y: number } | null>(
    null,
  );
```

**3d.** Replace the `menuItems` useMemo with:

```ts
  const menuItems = useMemo(() => {
    if (!menu) return [];
    const { thread: clicked, targets } = menu;
    const n = targets.length;
    const multi = n > 1;
    const account = accounts.find((a) => a.id === clicked.accountId) ?? null;
    const replyMode = defaultReplyBehavior === 'reply-all' ? 'replyAll' : 'reply';
    return [
      { label: 'Copy', icon: CopyIcon, disabled: true },
      { label: 'Quick Print', icon: FileTextIcon, disabled: true },
      { separator: true },
      {
        label: 'Reply',
        icon: ReplyIcon,
        onSelect: () => {
          if (!account) return;
          void openComposerForThread(clicked, replyMode, account);
        },
      },
      {
        label: 'Reply All',
        icon: ReplyAllIcon,
        onSelect: () => {
          if (!account) return;
          void openComposerForThread(clicked, 'replyAll', account);
        },
      },
      {
        label: 'Forward',
        icon: MailSendIcon,
        onSelect: () => {
          if (!account) return;
          void openComposerForThread(clicked, 'forward', account);
        },
      },
      {
        label: multi
          ? clicked.isRead
            ? `Mark ${n} as Unread`
            : `Mark ${n} as Read`
          : clicked.isRead
            ? 'Mark as Unread'
            : 'Mark as Read',
        icon: MailIcon,
        onSelect: () => void markThreadsRead(targets, !clicked.isRead),
      },
      { separator: true },
      { label: 'Categorize', icon: TagIcon, disabled: true },
      {
        label: multi
          ? clicked.isStarred
            ? `Clear follow up on ${n} conversations`
            : `Follow up ${n} conversations`
          : clicked.isStarred
            ? 'Clear Follow Up'
            : 'Follow Up',
        icon: FlagIcon,
        onSelect: () => void setThreadsStarred(targets, !clicked.isStarred),
      },
      { label: 'Find Related', icon: SearchIcon, disabled: true },
      { label: 'Rules', icon: PreferencesMailRulesIcon, disabled: true },
      { separator: true },
      {
        label: multi ? `Move ${n} conversations…` : 'Move',
        icon: MoveIcon,
        onSelect: () => setMoveMenu({ threads: targets, x: menu.x, y: menu.y }),
      },
      { label: 'Junk', icon: BellIcon, disabled: true },
      {
        label: multi ? `Delete ${n} conversations` : 'Delete',
        icon: TrashIcon,
        danger: true,
        onSelect: () => void deleteThreads(targets),
      },
      {
        label: multi ? `Archive ${n} conversations` : 'Archive',
        icon: ArchiveIcon,
        onSelect: () => {
          if (multi) void archiveThreads(targets);
          else void archiveThread(clicked);
        },
      },
    ];
  }, [menu, accounts, defaultReplyBehavior, markThreadsRead, setThreadsStarred, deleteThreads]);
```

**3e.** Update the `FolderPickerMenu` render for the new `moveMenu` shape:

```tsx
      {moveMenu && (
        <FolderPickerMenu
          accountId={moveMenu.threads[0]?.accountId ?? ''}
          excludeLabelId={selectedFolder?.labelId}
          style={{ position: 'fixed', left: moveMenu.x, top: moveMenu.y, zIndex: 80 }}
          onSelect={(folder: MailFolder) => {
            void moveThreads(moveMenu.threads, folder.id, folder.remoteId ?? folder.name);
            setMoveMenu(null);
          }}
          onClose={() => setMoveMenu(null)}
        />
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd kylins.client.frontend && npx vitest run tests/components/layout/MessageList.test.tsx && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Run the full frontend test suite**

Run: `cd kylins.client.frontend && npx vitest run`
Expected: PASS — no regressions in other suites (ReadingPane, FolderPane, ribbon, stores).

- [ ] **Step 6: Commit**

```bash
git add kylins.client.frontend/src/components/layout/MessageList.tsx kylins.client.frontend/tests/components/layout/MessageList.test.tsx
git commit -m "feat(frontend): bulk context-menu actions for multi-selection"
```
