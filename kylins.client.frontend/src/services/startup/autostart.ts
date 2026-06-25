import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';

export async function getAutostartState(): Promise<boolean> {
  try {
    return await isEnabled();
  } catch (err) {
    console.error('Failed to read autostart state:', err);
    return false;
  }
}

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  try {
    if (enabled) {
      await enable();
    } else {
      await disable();
    }
  } catch (err) {
    console.error('Failed to set autostart state:', err);
  }
}
