import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';
import { usePreferencesStore } from '../../stores/preferencesStore';

// ---- Dedupe set (in-memory, bounded) ----
//
// Stable message ids already notified THIS SESSION. Capped at MAX_DEDUPE so a
// long-running session doesn't grow it without bound; when exceeded the oldest
// entry is evicted FIFO. Dedupe key = `messages.id`
// (`imap-{account}-{folder}-{uid}` for IMAP, `eas-{...}` for EAS) — stable
// across syncs, so the same message arriving in two consecutive sync deltas
// (e.g. a VANNESS+re-fetch race, or a folder that didn't advance its cursor)
// only notifies once.
//
// Module-level (not React state) on purpose: notifications fire from event
// listeners outside React's render cycle, and the set must persist across
// renders without triggering re-renders itself. `clearNotificationDedupe` is
// the test seam that resets both structures between cases.
const MAX_DEDUPE = 500;
const recentlyNotifiedIds = new Set<string>();
const dedupeOrder: string[] = [];

function rememberId(id: string): void {
  if (recentlyNotifiedIds.has(id)) return;
  recentlyNotifiedIds.add(id);
  dedupeOrder.push(id);
  // FIFO eviction: drop the oldest entry once we exceed the cap. `shift()` is
  // O(n) but only runs on the over-cap path (one in MAX_DEDUPE adds), so the
  // amortized cost is negligible.
  if (dedupeOrder.length > MAX_DEDUPE) {
    const oldest = dedupeOrder.shift();
    if (oldest) recentlyNotifiedIds.delete(oldest);
  }
}

/** Test-only hook: clear the dedupe set between cases. */
export function clearNotificationDedupe(): void {
  recentlyNotifiedIds.clear();
  dedupeOrder.length = 0;
}

async function ensurePermission(): Promise<boolean> {
  try {
    const granted = await isPermissionGranted();
    if (granted) return true;
    const result = await requestPermission();
    return result === 'granted';
  } catch (err) {
    console.error('Notification permission check failed:', err);
    return false;
  }
}

function sendNotification(title: string, body: string) {
  // Send via Rust command so Windows toast attribution uses the
  // correct AppUserModelID (com.mailclient.app) instead of "Windows PowerShell".
  invoke('send_desktop_notification', { title, body }).catch(() => {});
}

/**
 * True iff the user wants notifications AND Do Not Disturb is off. Centralized
 * so every entry point (single-message, batch, repeated-open) honors the same
 * gate — DND is a hard suppress, not per-path.
 */
function notificationsAllowed(): boolean {
  const prefs = usePreferencesStore.getState();
  return prefs.showNotificationsForNewUnread && !prefs.doNotDisturb;
}

/**
 * Notify a single new message, deduped by stable message id. If `messageId`
 * was already notified this session, the call is a no-op. Used by future
 * callers (today only the batch path is wired from `useSyncEvents`).
 */
export async function notifyNewMail(
  sender: string,
  subject: string,
  messageId?: string,
): Promise<void> {
  const { playSoundOnNewMail } = usePreferencesStore.getState();

  if (!notificationsAllowed()) return;
  if (messageId && recentlyNotifiedIds.has(messageId)) return;

  const permitted = await ensurePermission();
  if (!permitted) return;

  sendNotification('New message', `${sender}: ${subject}`);
  if (messageId) rememberId(messageId);

  if (playSoundOnNewMail) {
    // Placeholder: wire an actual new-mail sound file once assets are available.
    console.log('[notification] would play new-mail sound');
  }
}

/**
 * Notify a batch of new messages, deduped by stable message id. If
 * `messageIds` is omitted, falls back to the raw `count` (no per-message
 * dedupe — used by sources that don't surface ids yet, or for the legacy
 * event payload shape). When some ids were already notified, the body
 * reflects only the count of NEW ids, so "2 new messages" doesn't re-fire
 * for the same pair on the next sync tick.
 */
export function notifyNewMailBatchDeduped(count: number, messageIds?: string[]): void {
  if (!notificationsAllowed()) return;

  let effectiveCount = count;
  if (messageIds && messageIds.length > 0) {
    const fresh = messageIds.filter((id) => !recentlyNotifiedIds.has(id));
    if (fresh.length === 0) return; // entire batch already notified
    effectiveCount = fresh.length;
    fresh.forEach(rememberId);
  }

  if (effectiveCount <= 0) return;
  sendNotification('New mail', `${effectiveCount} new message${effectiveCount === 1 ? '' : 's'}`);
}

/** Legacy count-only entry point. Prefer `notifyNewMailBatchDeduped`. */
export function notifyNewMailBatch(count: number): void {
  notifyNewMailBatchDeduped(count, undefined);
}

export async function notifyRepeatedOpen(sender: string, subject: string): Promise<void> {
  // Repeated-opens notifications have their own enable flag, but DND still
  // suppresses them (DND is a hard suppress). Note this path intentionally
  // does NOT consult `showNotificationsForNewUnread` — a user may disable
  // new-mail notifications while still wanting repeated-open alerts.
  const { showNotificationsForRepeatedOpens, doNotDisturb } = usePreferencesStore.getState();
  if (!showNotificationsForRepeatedOpens || doNotDisturb) return;

  const permitted = await ensurePermission();
  if (!permitted) return;

  sendNotification('Message opened again', `${sender}: ${subject}`);
}
