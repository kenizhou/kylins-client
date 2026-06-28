// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Per-sender remote-image allowlist over the `image_allowlist` table. A sender
// on the allowlist has its remote images loaded automatically (trackers are
// still stripped — see utils/imageBlocker).
//
// Task 5 (Option C) clean-cut cutover: every function delegates to a Rust
// `db_*` Tauri command (see `kylins.client.backend/src/db/image_allowlist.rs`).
// Email normalization now happens Rust-side.

import { invoke } from '@tauri-apps/api/core';

export async function addToAllowlist(accountId: string, senderAddress: string): Promise<void> {
  await invoke<void>('db_add_to_image_allowlist', { accountId, senderAddress });
}

export async function isAllowlisted(accountId: string, senderAddress: string): Promise<boolean> {
  return invoke<boolean>('db_is_image_allowlisted', { accountId, senderAddress });
}

export async function removeFromAllowlist(accountId: string, senderAddress: string): Promise<void> {
  await invoke<void>('db_remove_from_image_allowlist', { accountId, senderAddress });
}
