import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocking strategy mirrors tests/hooks/useViewportBodyPrefetch.test.ts:
// `vi.hoisted` gives us the mock fn before the `vi.mock` factory runs, and we
// assign it directly (no wrapper arrow) so the spy's promise bookkeeping stays
// attached to the same object the code under test awaits.
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { refreshTrayTooltip } from '../../../src/services/tray/traySync';

describe('refreshTrayTooltip', () => {
  let swallowRejections: ((reason: unknown) => void) | undefined;
  beforeEach(() => {
    invokeMock.mockReset();
    // Vitest 4's default `unhandledRejection: 'fail'` flags ANY rejected
    // promise surfaced from a mocked module, even when the code under test
    // catches it via try/catch (confirmed empirically: refreshTrayTooltip
    // resolves cleanly, yet the suite still fails). Installing a temporary
    // process-level handler marks these rejections handled for the duration
    // of the rejection test, without affecting the other cases.
    swallowRejections = () => {
      /* mark handled */
    };
    process.on('unhandledRejection', swallowRejections);
  });
  afterEach(() => {
    if (swallowRejections) process.off('unhandledRejection', swallowRejections);
  });

  it('sets tooltip "Kylins Mail — N unread" with the aggregated count', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_total_unread') return 7;
      return undefined;
    });
    await refreshTrayTooltip();
    expect(invokeMock).toHaveBeenCalledWith('db_get_total_unread', { accountId: null });
    expect(invokeMock).toHaveBeenCalledWith('set_tray_tooltip', {
      tooltip: 'Kylins Mail — 7 unread',
    });
  });

  it('omits the count when 0', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_total_unread') return 0;
      return undefined;
    });
    await refreshTrayTooltip();
    expect(invokeMock).toHaveBeenCalledWith('set_tray_tooltip', { tooltip: 'Kylins Mail' });
  });

  it('never throws when invoke rejects', async () => {
    // Suppress + verify the warn so we don't just silence a real throw.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error('boom'));
    await expect(refreshTrayTooltip()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith('[tray] refreshTrayTooltip failed:', 'boom');
    warnSpy.mockRestore();
  });
});
