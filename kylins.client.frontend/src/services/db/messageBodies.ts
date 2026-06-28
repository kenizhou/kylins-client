// Separate HTML body store (migration v34). The bulky rendered HTML lives
// here, fetched lazily when a message is opened; `messages` keeps only
// `body_text` (for FTS + the reading-pane text fallback). Bodies can be
// evicted to reclaim space and re-fetched on demand via `setMessageBody`.
//
// Task 5 (Option C) cutover: this module no longer touches plugin-sql. Each
// function delegates to a Rust `db_*` command. Rust returns the body row
// already shaped as the camelCase `MessageBody` interface, so no mapping is
// needed.

import { invoke } from '@tauri-apps/api/core';

export interface MessageBody {
  accountId: string;
  messageId: string;
  bodyHtml: string | null;
  fetchedAt: number | null;
}

export async function getMessageBody(
  accountId: string,
  messageId: string,
): Promise<MessageBody | null> {
  return invoke<MessageBody | null>('db_get_message_body', { accountId, messageId });
}

/** Store/refresh a body and mark the message as body-cached (atomic). */
export async function setMessageBody(
  accountId: string,
  messageId: string,
  bodyHtml: string,
): Promise<void> {
  await invoke<void>('db_set_message_body', { accountId, messageId, bodyHtml });
}

/** Drop a body to reclaim space (re-fetched on next open); atomic. */
export async function evictBody(accountId: string, messageId: string): Promise<void> {
  await invoke<void>('db_evict_body', { accountId, messageId });
}
