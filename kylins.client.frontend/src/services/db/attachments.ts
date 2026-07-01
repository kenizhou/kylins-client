// Attachment metadata + on-demand part fetching.
//
// `db_get_attachments` lists the metadata rows persisted by the body-fetch
// path (`request_bodies_inner` → `db::attachments::upsert_attachments`).
// `sync_fetch_attachment` fetches ONE part's bytes (base64) for download, and
// `sync_fetch_inline_images` fetches every inline `cid:` part in a single
// round-trip so the reading pane can build a `cid -> data:` URL map.
//
// DTOs match the Rust serde (camelCase) in `db/attachments.rs` and
// `sync_engine/commands.rs` (`AttachmentBytes`, `InlineCidPart`).

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

/** Decoded attachment bytes (mirrors `AttachmentBytes`). */
export interface AttachmentBytes {
  mimeType: string;
  base64: string;
}

/** One inline `cid:` part (mirrors `InlineCidPart`). */
export interface InlineCidPart {
  contentId: string;
  mimeType: string;
  base64: string;
}

/** List attachment metadata for a message. */
export function getAttachments(accountId: string, messageId: string): Promise<AttachmentRow[]> {
  return invoke<AttachmentRow[]>('db_get_attachments', { accountId, messageId });
}

/** Fetch ONE attachment part's bytes (base64) by IMAP section, for download. */
export function fetchAttachment(
  accountId: string,
  messageId: string,
  partId: string,
): Promise<AttachmentBytes> {
  return invoke<AttachmentBytes>('sync_fetch_attachment', { accountId, messageId, partId });
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
