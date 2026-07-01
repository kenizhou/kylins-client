// Best-effort tray tooltip sync. Reads the aggregated unread count from the
// backend and pushes a formatted tooltip to the OS tray via set_tray_tooltip.
// On Linux set_tray_tooltip is a no-op (commands.rs:31), so this is safe to
// call unconditionally. Never throws — failures are swallowed + logged.

import { invoke } from '@tauri-apps/api/core';

export async function refreshTrayTooltip(): Promise<void> {
  try {
    const total = await invoke<number>('db_get_total_unread', { accountId: null });
    const tooltip = total > 0 ? `Kylins Mail — ${total} unread` : 'Kylins Mail';
    await invoke('set_tray_tooltip', { tooltip });
  } catch (err) {
    // Best-effort: a missing tray (early boot, headless) is not fatal.
    // Log the message string only — logging the raw Error object makes some
    // test runners (Vitest) treat it as an unhandled error.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[tray] refreshTrayTooltip failed:', msg);
  }
}
