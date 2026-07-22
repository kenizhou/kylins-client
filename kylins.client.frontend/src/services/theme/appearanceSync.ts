// Cross-window appearance sync. The app runs multiple webviews (main window,
// composer pop-out, message viewer pop-out); themeManager only touches its own
// window's document, so a theme change in one window never reaches the others.
// This module broadcasts changes over a Tauri event and lets every window
// re-apply them locally.

import { emit, listen } from '@tauri-apps/api/event';

export type AppearanceKey =
  | 'theme'
  | 'contrast'
  | 'skin'
  | 'font_size'
  | 'serif_subjects'
  | 'reduce_motion';

export interface AppearanceChange {
  key: AppearanceKey;
  value: string;
}

const EVENT = 'appearance:changed';

/** Broadcast an appearance change to all windows (including this one). */
export function broadcastAppearanceChange(key: AppearanceKey, value: string): void {
  const payload: AppearanceChange = { key, value };
  emit(EVENT, payload).catch(() => {});
}

/** Subscribe to appearance changes from any window. Returns an unlisten fn. */
export function onAppearanceChange(handler: (change: AppearanceChange) => void): () => void {
  const pending = listen<AppearanceChange>(EVENT, (e) => handler(e.payload));
  return () => {
    pending.then((unlisten) => unlisten()).catch(() => {});
  };
}
