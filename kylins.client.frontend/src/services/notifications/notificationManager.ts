import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';
import { usePreferencesStore } from '../../stores/preferencesStore';

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

export async function notifyNewMail(sender: string, subject: string): Promise<void> {
  const { showNotificationsForNewUnread, playSoundOnNewMail } = usePreferencesStore.getState();

  if (!showNotificationsForNewUnread) return;

  const permitted = await ensurePermission();
  if (!permitted) return;

  sendNotification('New message', `${sender}: ${subject}`);

  if (playSoundOnNewMail) {
    // Placeholder: wire an actual new-mail sound file once assets are available.
    console.log('[notification] would play new-mail sound');
  }
}

export function notifyNewMailBatch(count: number): void {
  const { showNotificationsForNewUnread } = usePreferencesStore.getState();
  if (!showNotificationsForNewUnread) return;

  sendNotification('New mail', `${count} new message${count === 1 ? '' : 's'}`);
}

export async function notifyRepeatedOpen(sender: string, subject: string): Promise<void> {
  const { showNotificationsForRepeatedOpens } = usePreferencesStore.getState();
  if (!showNotificationsForRepeatedOpens) return;

  const permitted = await ensurePermission();
  if (!permitted) return;

  sendNotification('Message opened again', `${sender}: ${subject}`);
}
