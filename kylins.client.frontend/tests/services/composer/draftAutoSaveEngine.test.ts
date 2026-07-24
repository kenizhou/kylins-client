// Tests for the shared debounced draft-save engine: debounce timing, the
// content-changed gate, staleness token on the write-back, flush semantics,
// and stop().

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockSaveDraft, mockDeleteDraft } = vi.hoisted(() => ({
  mockSaveDraft: vi.fn(async () => 'row-1'),
  mockDeleteDraft: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/composer/drafts', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/composer/drafts')>(
    '../../../src/services/composer/drafts',
  );
  return { ...actual, saveDraft: mockSaveDraft, deleteDraft: mockDeleteDraft };
});

import { createDraftAutoSave } from '../../../src/services/composer/draftAutoSaveEngine';
import type { DraftInput } from '../../../src/services/composer/drafts';

interface TestSession {
  token: string;
  draftId: string | null;
  body: string;
  dirty: boolean;
}

function makeHarness(initial: TestSession | null = null) {
  let session = initial;
  const listeners: Array<(next: TestSession | null, prev: TestSession | null) => void> = [];
  const saved: Array<{ id: string }> = [];
  const policy = {
    subscribe: (listener: (next: TestSession | null, prev: TestSession | null) => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    getSession: () => session,
    sessionToken: (s: TestSession) => s.token,
    shouldSave: (s: TestSession) => s.dirty,
    contentChanged: (a: TestSession, b: TestSession) => a.body !== b.body,
    toInput: (s: TestSession): DraftInput => ({
      accountId: 'acc-1',
      to: [],
      subject: '',
      bodyHtml: s.body,
    }),
    draftId: (s: TestSession) => s.draftId,
    onSaved: (s: TestSession, id: string) => {
      saved.push({ id });
      session = { ...s, draftId: id };
    },
  };
  const handle = createDraftAutoSave(policy);
  const emit = (next: TestSession | null, prev: TestSession | null) => {
    const old = session;
    session = next;
    for (const l of listeners) l(next, prev ?? old);
  };
  return { handle, emit, saved, getSession: () => session };
}

describe('createDraftAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSaveDraft.mockClear();
    mockDeleteDraft.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves after the debounce and writes the row id back', async () => {
    const h = makeHarness();
    h.handle.start();
    h.emit({ token: 'a', draftId: null, body: 'one', dirty: true }, null);
    expect(mockSaveDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);
    expect(h.saved).toEqual([{ id: 'row-1' }]);
    expect(h.getSession()?.draftId).toBe('row-1');
    h.handle.stop();
  });

  it('coalesces rapid edits into one save', async () => {
    const h = makeHarness();
    h.handle.start();
    h.emit({ token: 'a', draftId: null, body: 'one', dirty: true }, null);
    await vi.advanceTimersByTimeAsync(1000);
    h.emit({ token: 'a', draftId: null, body: 'two', dirty: true }, null);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);
    expect(mockSaveDraft.mock.calls[0]![0].bodyHtml).toBe('two');
    h.handle.stop();
  });

  it('skips sessions that fail the gate and unchanged content', async () => {
    const h = makeHarness();
    h.handle.start();
    h.emit({ token: 'a', draftId: null, body: 'one', dirty: false }, null); // gate fails
    const s = { token: 'a', draftId: null, body: 'one', dirty: true };
    h.emit(s, s); // content unchanged (same body)
    await vi.advanceTimersByTimeAsync(10000);
    expect(mockSaveDraft).not.toHaveBeenCalled();
    h.handle.stop();
  });

  it('does not write back when the session was replaced mid-save', async () => {
    let resolveSave: ((id: string) => void) | null = null;
    mockSaveDraft.mockImplementationOnce(
      () =>
        new Promise<string>((res) => {
          resolveSave = res;
        }),
    );
    const h = makeHarness();
    h.handle.start();
    h.emit({ token: 'a', draftId: null, body: 'one', dirty: true }, null);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);

    // Session replaced while the save is in flight.
    h.emit({ token: 'b', draftId: null, body: 'other', dirty: true }, null);
    resolveSave!('row-stale');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.saved).toEqual([]); // stale write-back dropped
    h.handle.stop();
  });

  it('flush saves immediately and reports failure', async () => {
    const h = makeHarness({ token: 'a', draftId: null, body: 'one', dirty: true });
    h.handle.start();
    const ok = await h.handle.flush();
    expect(ok).toBe(true);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);

    mockSaveDraft.mockRejectedValueOnce(new Error('db gone'));
    const fail = await h.handle.flush();
    expect(fail).toBe(false);
    h.handle.stop();
  });

  it('deletes the row it just wrote when the session died mid-save (no resurrection)', async () => {
    let resolveSave: ((id: string) => void) | null = null;
    mockSaveDraft.mockImplementationOnce(
      () =>
        new Promise<string>((res) => {
          resolveSave = res;
        }),
    );
    const h = makeHarness();
    h.handle.start();
    h.emit({ token: 'a', draftId: null, body: 'one', dirty: true }, null);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockSaveDraft).toHaveBeenCalledTimes(1);

    // Session discarded while the save is in flight.
    h.emit(null, null);
    resolveSave!('row-orphan');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.saved).toEqual([]);
    // Compensating delete: the just-written row must not survive as an orphan.
    expect(mockDeleteDraft).toHaveBeenCalledWith('row-orphan');
    h.handle.stop();
  });

  it('stop cancels a pending debounce', async () => {
    const h = makeHarness();
    h.handle.start();
    h.emit({ token: 'a', draftId: null, body: 'one', dirty: true }, null);
    h.handle.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(mockSaveDraft).not.toHaveBeenCalled();
  });
});
