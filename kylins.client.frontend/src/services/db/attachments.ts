// Attachment metadata + on-demand part fetching.
//
// `db_get_attachments` lists the metadata rows persisted by the body-fetch
// path (`request_bodies_inner` → `db::attachments::upsert_attachments`).
// `sync_fetch_attachment` fetches ONE part, caches it as a file under
// `<appData>/attachment-cache/`, and returns the file path (no base64 over
// IPC — the receive-path counterpart to T7b's send-path staging).
// `sync_fetch_inline_images` fetches every inline `cid:` part in a single
// round-trip so the reading pane can build a `cid -> data:` URL map.
//
// DTOs match the Rust serde (camelCase) in `db/attachments.rs`,
// `sync_engine/commands.rs` (`InlineCidPart`), and `attachment_cache.rs`
// (`CachedAttachment`).

import { invoke } from '@tauri-apps/api/core';

/** One attachment-metadata row (mirrors `db::attachments::AttachmentRow`). */
export interface AttachmentRow {
  id: string;
  accountId: string;
  messageId: string;
  filename?: string | null;
  mimeType?: string | null;
  size: number;
  contentId?: string | null;
  isInline: boolean;
  imapPartId?: string | null;
}

/** Cached attachment (mirrors `attachment_cache::CachedAttachment`). The
 * `filePath` is absolute, under `<appData>/attachment-cache/`. The caller
 * either `copyFile`s it into the draft outbox (forward) or
 * `copy_cached_attachment`s it to a user-chosen save location (download). */
export interface CachedAttachment {
  filePath: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** One inline `cid:` part (mirrors `InlineCidPart`). Still base64 — inline
 * images are small (signature logos, emojis); a future enhancement could cache
 * them as files + serve via `convertFileSrc`. */
export interface InlineCidPart {
  contentId: string;
  mimeType: string;
  base64: string;
}

/** List attachment metadata for a message. */
export function getAttachments(accountId: string, messageId: string): Promise<AttachmentRow[]> {
  return invoke<AttachmentRow[]>('db_get_attachments', { accountId, messageId });
}

/** Fetch ONE attachment part — cache-check → fetch-on-miss → return a file
 * path (no base64). First call fetches from IMAP + writes to disk; subsequent
 * calls return the cached path immediately (no network). */
export function fetchAttachment(
  accountId: string,
  messageId: string,
  partId: string,
): Promise<CachedAttachment> {
  return invoke<CachedAttachment>('sync_fetch_attachment', { accountId, messageId, partId });
}

/** Fetch every inline `cid:` part for a message in one round-trip. */
export function fetchInlineImages(accountId: string, messageId: string): Promise<InlineCidPart[]> {
  return invoke<InlineCidPart[]>('sync_fetch_inline_images', { accountId, messageId });
}

/**
 * Extract the set of `cid:` references actually used in an HTML body. Used to
 * exclude inline images from the attachment list (they render in-body) — mirrors
 * velo's `referencedCids` (MessageItem.tsx).
 */
export function referencedCids(bodyHtml: string | null | undefined): Set<string> {
  const cids = new Set<string>();
  if (!bodyHtml) return cids;
  const re = /\bcid:([^"'\s)]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyHtml)) !== null) {
    cids.add(m[1]!);
  }
  return cids;
}
