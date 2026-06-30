// Viewport body-prefetch hook. Two contract tests from the Task 3 brief:
//   1. no-op when no visible items (debounce still fires, but the empty
//      visible-range guard returns before any invoke)
//   2. after the 250ms debounce, invokes `sync_request_bodies` with the
//      UNCACHED subset of the visible+buffer ids (cached ids are filtered out
//      by the `getUncachedBodyMessageIds` mock).
//
// Mocking strategy mirrors `tests/services/db/messageBodies.test.ts`: hoisted
// `vi.mock` replaces `@tauri-apps/api/core` + the db wrapper so the hook never
// reaches a real Tauri bridge. `__TAURI_INTERNALS__` is set in `beforeEach`
// (jsdom doesn't have it; without it the hook short-circuits to a no-op).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockInvoke, mockGetUncached } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockGetUncached: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));
vi.mock('../../src/services/db/messages', () => ({
  getUncachedBodyMessageIds: mockGetUncached,
}));

import { useViewportBodyPrefetch } from '../../src/hooks/useViewportBodyPrefetch';

describe('useViewportBodyPrefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockGetUncached.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    // jsdom has no __TAURI_INTERNALS__; the hook checks for it and is a no-op
    // without it. Force-enable so the test exercises the real path.
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('is a no-op when there are no visible items', async () => {
    const virtualizer = { getVirtualItems: () => [] } as never;
    renderHook(() => useViewportBodyPrefetch({ virtualizer, threads: [], accountId: 'a' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('invokes sync_request_bodies with uncached visible ids after debounce', async () => {
    // Only 't2' comes back as uncached -> that's the only id we should request.
    mockGetUncached.mockResolvedValue(['t2']);
    const virtualizer = {
      getVirtualItems: () => [{ index: 0 }, { index: 1 }, { index: 2 }],
    } as never;
    const threads = [{ id: 't0' }, { id: 't1' }, { id: 't2' }] as never;
    renderHook(() => useViewportBodyPrefetch({ virtualizer, threads, accountId: 'a' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockGetUncached).toHaveBeenCalledWith('a', ['t0', 't1', 't2']);
    expect(mockInvoke).toHaveBeenCalledWith('sync_request_bodies', {
      accountId: 'a',
      messageIds: ['t2'],
    });
  });

  it('skips the fetch entirely while the account is rate-limited', async () => {
    // Seed the rate-limit set BEFORE the hook fires.
    const { useUIStore } = await import('../../src/stores/uiStore');
    useUIStore.getState().setRateLimited('a', true);
    mockGetUncached.mockResolvedValue(['t1']);
    const virtualizer = {
      getVirtualItems: () => [{ index: 0 }, { index: 1 }],
    } as never;
    const threads = [{ id: 't0' }, { id: 't1' }] as never;
    renderHook(() => useViewportBodyPrefetch({ virtualizer, threads, accountId: 'a' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGetUncached).not.toHaveBeenCalled();
    // Cleanup so the rate-limit flag doesn't leak into the next test.
    useUIStore.getState().setRateLimited('a', false);
  });

  it('does not invoke sync_request_bodies when every visible id is already cached', async () => {
    mockGetUncached.mockResolvedValue([]); // everything cached
    const virtualizer = {
      getVirtualItems: () => [{ index: 0 }, { index: 1 }],
    } as never;
    const threads = [{ id: 't0' }, { id: 't1' }] as never;
    renderHook(() => useViewportBodyPrefetch({ virtualizer, threads, accountId: 'a' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockGetUncached).toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('is a no-op outside Tauri (no __TAURI_INTERNALS__)', async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const virtualizer = {
      getVirtualItems: () => [{ index: 0 }],
    } as never;
    const threads = [{ id: 't0' }] as never;
    renderHook(() => useViewportBodyPrefetch({ virtualizer, threads, accountId: 'a' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('does nothing when accountId is null', async () => {
    const virtualizer = {
      getVirtualItems: () => [{ index: 0 }],
    } as never;
    const threads = [{ id: 't0' }] as never;
    renderHook(() => useViewportBodyPrefetch({ virtualizer, threads, accountId: null }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
