// Open a URL in the user's default browser. Prefers the Tauri opener plugin
// (registered on the Rust side); falls back to window.open when the plugin is
// absent (tests, or a build where the backend plugin isn't wired yet).

export async function openExternalUrl(url: string): Promise<void> {
  try {
    const mod = await import('@tauri-apps/plugin-opener');
    await mod.openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
