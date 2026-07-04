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
import { renderHook, render, screen, act, fireEvent } from '@testing-library/react';
import React, { useRef } from 'react';

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
import { useAutoHideScrollbar } from '../../src/hooks/useAutoHideScrollbar';

function makeItems(ids: string[]) {
  return ids.map((id) => ({ kind: 'thread' as const, thread: { id } as never }));
}

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
    renderHook(() => useViewportBodyPrefetch({ virtualizer, items: [], accountId: 'a' }));
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
    renderHook(() =>
      useViewportBodyPrefetch({
        virtualizer,
        items: makeItems(['t0', 't1', 't2']),
        accountId: 'a',
      }),
    );
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
    renderHook(() =>
      useViewportBodyPrefetch({ virtualizer, items: makeItems(['t0', 't1']), accountId: 'a' }),
    );
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
    renderHook(() =>
      useViewportBodyPrefetch({ virtualizer, items: makeItems(['t0', 't1']), accountId: 'a' }),
    );
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
    renderHook(() =>
      useViewportBodyPrefetch({ virtualizer, items: makeItems(['t0']), accountId: 'a' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('does nothing when accountId is null', async () => {
    const virtualizer = {
      getVirtualItems: () => [{ index: 0 }],
    } as never;
    renderHook(() =>
      useViewportBodyPrefetch({ virtualizer, items: makeItems(['t0']), accountId: null }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ---- Task 3b: robustness scenarios ----

  it('fires immediately on first mount (no debounce) when items are visible', async () => {
    // First-mount must NOT wait for the 250ms debounce — the initial viewport
    // should prefetch on the next tick. We do NOT advance the 250ms timer.
    mockGetUncached.mockResolvedValue(['t1']);
    const virtualizer = {
      getVirtualItems: () => [{ index: 0 }, { index: 1 }],
    } as never;
    renderHook(() =>
      useViewportBodyPrefetch({
        virtualizer,
        items: makeItems(['t0', 't1']),
        accountId: 'a',
      }),
    );
    // Flush the microtask queue so the 0-ms timeout's async body can run,
    // WITHOUT advancing the 250ms debounce timer.
    await act(async () => {
      // A 0-ms timeout still needs one timer tick to fire.
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockInvoke).toHaveBeenCalledWith('sync_request_bodies', {
      accountId: 'a',
      messageIds: ['t1'],
    });
  });

  it('skips group headers when mapping virtual-item indices to thread ids', async () => {
    mockGetUncached.mockResolvedValue(['t2']);
    const virtualizer = {
      // Virtualizer sees 4 rows: 1 group header + 3 threads.
      getVirtualItems: () => [{ index: 1 }, { index: 2 }, { index: 3 }],
    } as never;
    const items = [{ kind: 'group' as const, label: 'Today' }, ...makeItems(['t0', 't1', 't2'])];
    renderHook(() => useViewportBodyPrefetch({ virtualizer, items, accountId: 'a' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockGetUncached).toHaveBeenCalledWith('a', ['t0', 't1', 't2']);
    expect(mockInvoke).toHaveBeenCalledWith('sync_request_bodies', {
      accountId: 'a',
      messageIds: ['t2'],
    });
  });

  it('prefetches on scroll events when useAutoHideScrollbar shares the scroll container', async () => {
    mockGetUncached.mockResolvedValue(['t1']);

    function ScrollContainer() {
      const scrollRef = useRef<HTMLDivElement>(null);
      const virtualizer = {
        getVirtualItems: () => [{ index: 0 }, { index: 1 }],
        options: { getScrollElement: () => scrollRef.current },
      } as never;
      useAutoHideScrollbar(scrollRef);
      useViewportBodyPrefetch({ virtualizer, items: makeItems(['t0', 't1']), accountId: 'a' });
      return React.createElement(
        'div',
        { ref: scrollRef, 'data-testid': 'scroll', style: { overflow: 'auto', height: 200 } },
        React.createElement('div', { style: { height: 2000 } }),
      );
    }

    render(React.createElement(ScrollContainer));

    // First-mount immediate batch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Scroll should schedule another batch once the 1s throttle window passes.
    vi.setSystemTime(new Date(Date.now() + 1200));
    const scrollEl = screen.getByTestId('scroll');
    fireEvent.scroll(scrollEl);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});
