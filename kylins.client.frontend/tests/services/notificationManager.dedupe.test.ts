import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
// isPermissionGranted/requestPermission short-circuit to "granted".
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => 'granted',
}));

import {
  notifyNewMailBatchDeduped,
  clearNotificationDedupe,
} from '../../src/services/notifications/notificationManager';
import { usePreferencesStore } from '../../src/stores/preferencesStore';

describe('notificationManager dedupe + DND', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    clearNotificationDedupe();
    usePreferencesStore.setState({
      showNotificationsForNewUnread: true,
      doNotDisturb: false,
    });
  });

  it('fires once for a fresh set of ids', () => {
    notifyNewMailBatchDeduped(3, ['m1', 'm2', 'm3']);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('send_desktop_notification', {
      title: 'New mail',
      body: '3 new messages',
    });
  });

  it('does NOT fire when all ids were already notified', () => {
    notifyNewMailBatchDeduped(2, ['m1', 'm2']);
    notifyNewMailBatchDeduped(2, ['m1', 'm2']);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('fires with the count of NEW ids when the batch is partially seen', () => {
    notifyNewMailBatchDeduped(2, ['m1', 'm2']);
    invokeMock.mockClear();
    notifyNewMailBatchDeduped(3, ['m1', 'm2', 'm3']);
    // 1 new id -> body says "1 new message".
    expect(invokeMock).toHaveBeenCalledWith('send_desktop_notification', {
      title: 'New mail',
      body: '1 new message',
    });
  });

  it('does NOT fire when DND is on, even for fresh ids', () => {
    usePreferencesStore.setState({ doNotDisturb: true });
    notifyNewMailBatchDeduped(5, ['fresh1', 'fresh2']);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does NOT fire when showNotificationsForNewUnread is false', () => {
    usePreferencesStore.setState({ showNotificationsForNewUnread: false });
    notifyNewMailBatchDeduped(2, ['fresh1', 'fresh2']);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('falls back to the raw count when ids are not supplied', () => {
    notifyNewMailBatchDeduped(4);
    expect(invokeMock).toHaveBeenCalledWith('send_desktop_notification', {
      title: 'New mail',
      body: '4 new messages',
    });
  });

  // ---- Bounded set eviction (FIFO at cap) ----
  //
  // The dedupe set is capped (MAX_DEDUPE = 500) so a long-running session
  // doesn't grow it without bound. When the cap is exceeded the OLDEST id is
  // evicted (FIFO), meaning a subsequent batch containing that evicted id is
  // treated as fresh again. This test drives 501 distinct ids through the
  // dedupe path (the first id "id-0" gets evicted), then re-notifies "id-0"
  // and asserts the notification fires again (proving eviction, not just
  // "still remembered").
  it('evicts the oldest id once the dedupe cap is exceeded (FIFO)', () => {
    // Populate exactly MAX_DEDUPE (500) distinct ids in one batch. Use a count
    // matching the batch so the body assertion is deterministic.
    const fullBatch: string[] = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    notifyNewMailBatchDeduped(500, fullBatch);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeMock.mockClear();

    // One more distinct id pushes the set over the cap; the oldest ("id-0")
    // is evicted. The new id is fresh so a notification fires.
    notifyNewMailBatchDeduped(1, ['id-500']);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeMock.mockClear();

    // "id-0" was evicted -> re-notifying it must fire again (regression: if
    // eviction were broken, this would be silently dropped).
    notifyNewMailBatchDeduped(1, ['id-0']);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('send_desktop_notification', {
      title: 'New mail',
      body: '1 new message',
    });
  });
});
