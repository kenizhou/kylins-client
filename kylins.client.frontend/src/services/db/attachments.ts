// Attachment metadata + on-demand part fetching.
//
// `db_get_attachments` lists the metadata rows persisted by the body-fetch
// path (`request_bodies_inner` → `db::attachments::upsert_attachments`).
// `sync_fetch_attachment` fetches ONE part, caches it as a file under
// `<appData>/attachment-cache/`, and returns the file path (no base64 over
// IPC — the receive-path counterpart to T7b's send-path staging).
// `sync_fetch_inline_images` cache-checks every inline `cid:` part and returns
// file paths — the reading pane renders via `convertFileSrc(filePath)` so
// base64 never goes into the displayed HTML.
//
// DTOs match the Rust serde (camelCase) in `db/attachments.rs`,
// `sync_engine/commands.rs` (`CachedInlineImage`), and `attachment_cache.rs`
// (`CachedAttachment`, `CachedInlineImage`).

import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';

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

/** One cached inline `cid:` image (mirrors `attachment_cache::CachedInlineImage`).
 * The `filePath` is absolute, under `<appData>/attachment-cache/`. The reading
 * pane renders it via `convertFileSrc(filePath)` (asset protocol URL) — no
 * base64 in the HTML. */
export interface CachedInlineImage {
  contentId: string;
  filePath: string;
  mimeType: string;
  size: number;
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

/** Fetch every inline `cid:` image for a message. Cache-check → fetch-on-miss
 * → return file paths (no base64). First call fetches from IMAP + writes cache
 * files; subsequent calls return cached paths immediately (no network). */
export function fetchInlineImages(
  accountId: string,
  messageId: string,
): Promise<CachedInlineImage[]> {
  return invoke<CachedInlineImage[]>('sync_fetch_inline_images', { accountId, messageId });
}

/**
 * Read a cached inline image file and return a `data:` URL. Needed for the
 * FORWARD path: the composer's send pipeline (`extractInlineImages`) matches
 * `data:` URLs to re-attach inline images as CID parts, so the forward seed
 * must use `data:` URLs (not `convertFileSrc` asset URLs). For DISPLAY in the
 * reading pane, prefer `convertFileSrc(filePath)` directly — no base64.
 */
export async function cachedImageToDataUrl(
  filePath: string,
  mimeType: string,
): Promise<string> {
  const bytes = await readFile(filePath);
  let base64: string;
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    base64 = btoa(binary);
  } else {
    // Node/test fallback (Buffer is available in jsdom/Node contexts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const B = (globalThis as any).Buffer;
    if (B) {
      base64 = B.from(bytes).toString('base64');
    } else {
      throw new Error('No base64 encoder available');
    }
  }
  return `data:${mimeType};base64,${base64}`;
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
