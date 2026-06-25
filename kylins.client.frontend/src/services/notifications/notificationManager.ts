import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
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

export async function notifyNewMail(sender: string, subject: string): Promise<void> {
  const { showNotificationsForNewUnread, playSoundOnNewMail } = usePreferencesStore.getState();

  if (!showNotificationsForNewUnread) return;

  const permitted = await ensurePermission();
  if (!permitted) return;

  sendNotification({
    title: 'New message',
    body: `${sender}: ${subject}`,
  });

  if (playSoundOnNewMail) {
    // Placeholder: wire an actual new-mail sound file once assets are available.
    console.log('[notification] would play new-mail sound');
  }
}

export async function notifyRepeatedOpen(sender: string, subject: string): Promise<void> {
  const { showNotificationsForRepeatedOpens } = usePreferencesStore.getState();
  if (!showNotificationsForRepeatedOpens) return;

  const permitted = await ensurePermission();
  if (!permitted) return;

  sendNotification({
    title: 'Message opened again',
    body: `${sender}: ${subject}`,
  });
}
