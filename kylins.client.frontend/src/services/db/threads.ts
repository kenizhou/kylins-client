// Thread list + per-thread message loading for the message list / reading pane.
//
// Task 5 (Option C) cutover: the read paths (`getThreads`, `getMessagesForThread`,
// `markThreadRead`) no longer touch plugin-sql. They delegate to Rust `db_*`
// commands (see `kylins.client.backend/src/db/commands.rs`). The bulk write
// path `upsertImapMessages` was DELETED — bulk message persistence moves to
// the Rust sync engine in a later task, and its sole caller
// (`services/mail/folderSync.ts`) was also deleted.
//
// `mapMessageToMailMessage` + `parseAddresses` are pure helpers kept verbatim;
// they consume the snake_case `MessageRow` Rust returns from
// `db_get_messages_for_thread` (Rust intentionally serializes that DTO
// snake_case so this mapper is unchanged).

import { invoke } from '@tauri-apps/api/core';
import type { MailMessage } from '../../features/view/viewStore';

export interface Thread {
  id: string;
  accountId: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: number | null;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
  isSnoozed: boolean;
  fromName: string | null;
  fromAddress: string | null;
  classificationId: string | null;
  isEncrypted: boolean;
  isSigned: boolean;
}

export interface ThreadCursor {
  date: number;
  id: string;
}

export interface GetThreadsOptions {
  /** Label/folder id. Every folder is a label in our model. */
  labelId?: string | null;
  limit?: number;
  /** Cursor from a previous page's nextCursor (keyset pagination). */
  cursor?: ThreadCursor | null;
}

export interface DbMessageRow {
  id: string;
  account_id: string;
  thread_id: string;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses?: string | null;
  reply_to?: string | null;
  subject: string | null;
  snippet: string | null;
  date: number;
  is_read: number;
  is_starred: number;
  body_text: string | null;
  body_cached?: number;
  message_id_header?: string | null;
  in_reply_to_header?: string | null;
  classification_id: string | null;
  is_encrypted: number;
  is_signed: number;
  /** IMAP UID (snake_case from Rust MessageRow). Null for non-IMAP sources. */
  imap_uid?: number | null;
  /** IMAP folder path the message lives in (e.g. "INBOX"). Null for non-IMAP. */
  imap_folder?: string | null;
}

/**
 * Load one page of threads for an account, optionally filtered to a label/folder.
 * Returns the page plus a cursor for the next page (null when the page was short).
 */
export async function getThreads(
  accountId: string,
  opts: GetThreadsOptions = {},
): Promise<{ threads: Thread[]; nextCursor: ThreadCursor | null }> {
  // Rust deserializes `{ labelId, limit, cursor }` into GetThreadsOptions; pass
  // them through verbatim. Null/undefined fields are omitted so Rust sees them
  // as `None`.
  return invoke<{ threads: Thread[]; nextCursor: ThreadCursor | null }>('db_get_threads', {
    accountId,
    opts: {
      labelId: opts.labelId ?? null,
      limit: opts.limit,
      cursor: opts.cursor ?? null,
    },
  });
}

/** Load a thread's message metadata (no body_html) ordered oldest→newest. */
export async function getMessagesForThread(
  accountId: string,
  threadId: string,
): Promise<DbMessageRow[]> {
  // Rust returns snake_case MessageRow JSON that matches DbMessageRow.
  return invoke<DbMessageRow[]>('db_get_messages_for_thread', { accountId, threadId });
}

/** Mark every message in a thread (and the thread row) as read, atomically. */
export async function markThreadRead(accountId: string, threadId: string): Promise<void> {
  await invoke<void>('db_mark_thread_read', { accountId, threadId });
}

/** Parse a comma-separated address list ("Name <a@x>, b@y") into structured rows. */
export function parseAddresses(
  raw: string | null | undefined,
): { name: string; address: string }[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
      if (m) {
        const name = (m[1] ?? '').trim();
        const address = (m[2] ?? s).trim();
        return { name: name || address, address };
      }
      return { name: s, address: s };
    });
}

/** Map a DB message row (+ lazily-fetched HTML body) to the app's MailMessage. */
export function mapMessageToMailMessage(
  msg: DbMessageRow,
  bodyHtml: string | null = null,
): MailMessage {
  const fromName = msg.from_name ?? msg.from_address ?? 'Unknown';
  return {
    id: msg.id,
    subject: msg.subject ?? '(no subject)',
    from: { name: fromName, address: msg.from_address ?? fromName },
    to: parseAddresses(msg.to_addresses),
    cc: parseAddresses(msg.cc_addresses),
    date: new Date((msg.date ?? 0) * 1000).toISOString(),
    preview: msg.snippet ?? '',
    html: bodyHtml,
    text: msg.body_text ?? null,
    threadId: msg.thread_id,
    messageId: msg.message_id_header ?? undefined,
    classificationId: msg.classification_id ?? null,
    isEncrypted: msg.is_encrypted === 1,
    isSigned: msg.is_signed === 1,
  };
}
