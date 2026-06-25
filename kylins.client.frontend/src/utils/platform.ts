/** Return true when running on macOS. Falls back to `navigator.platform` so it
 *  works in the Tauri webview, browser previews, and jsdom tests. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform?.toLowerCase() ?? '';
  return platform.includes('mac');
}
