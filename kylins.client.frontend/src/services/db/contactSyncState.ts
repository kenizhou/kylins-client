// Task 5 (Option C) clean-cut cutover: every function delegates to a Rust
// `db_*` Tauri command (see
// `kylins.client.backend/src/db/contact_sync_state.rs`). Rust owns the
// `contact_sync_state` table and returns camelCase DTOs matching the TS type.

import { invoke } from '@tauri-apps/api/core';

export interface ContactSyncState {
  accountId: string;
  source: string;
  syncToken: string | null;
  lastSyncAt: number | null;
}

export async function getContactSyncState(
  accountId: string,
  source: string,
): Promise<ContactSyncState | null> {
  return invoke<ContactSyncState | null>('db_get_contact_sync_state', { accountId, source });
}

export async function setContactSyncState(
  accountId: string,
  source: string,
  syncToken: string | null,
  lastSyncAt?: number,
): Promise<void> {
  await invoke<void>('db_set_contact_sync_state', {
    accountId,
    source,
    syncToken,
    lastSyncAt: lastSyncAt ?? null,
  });
}
