// Attachment list for the reading pane. Lists the non-inline attachments for a
// message (paperclip chips with filename + size); click to download via a save
// dialog. Inline `cid:` images are excluded here because they render in-body
// (resolved by ReadingPane's cidMap → EmailRenderer).
//
// Metadata comes from `db_get_attachments` (persisted by the body-fetch path).
// The download path uses `sync_fetch_attachment` (returns a cached file path,
// no base64 over IPC) → `copy_cached_attachment` (std::fs copy to the
// user-chosen save location, since plugin-fs can't write outside appData).
//
// DA-Task 3: when the selected message is encrypted (`isCrypto`), the
// attachment metadata is sourced from the DECRYPTED inner MIME via
// `decryptedAttachments` (an `ImapAttachment[]` from `OpenCryptoResult`).
// The list never calls `db_get_attachments` on the crypto branch (those rows
// describe the OUTER S/MIME envelope, which is filtered out as a crypto
// envelope type — useless to the user). Downloads go through
// `crypto_fetch_attachment` (re-decrypt → write part to cache) instead of
// `sync_fetch_attachment` (which would fetch the envelope, not the inner
// part).

import { useEffect, useState } from 'react';
import { Paperclip } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { Button } from 'react-aria-components';
import {
  type AttachmentRow,
  fetchAttachment,
  fetchCryptoAttachment,
  getAttachments,
  referencedCids,
} from '../../services/db/attachments';
import type { ImapAttachment } from '../../services/db/cryptoReceive';
import { formatFileSize } from '../../utils/fileTypeHelpers';

interface AttachmentListProps {
  accountId: string | null | undefined;
  messageId: string | null | undefined;
  /** Body HTML, used to detect which attachments are referenced by `cid:`
   *  inline and should be hidden from this list. */
  bodyHtml: string | null | undefined;
  /** DA-Task 3: decrypted inner-MIME attachments for an encrypted message.
   *  When `isCrypto && decryptedAttachments?.length`, the list renders these
   *  INSTEAD of querying `db_get_attachments` (whose rows describe the outer
   *  S/MIME envelope, not the user-visible inner parts). */
  decryptedAttachments?: ImapAttachment[];
  /** DA-Task 3: true when the selected message was opened through the crypto
   *  pipeline. Routes downloads to `crypto_fetch_attachment`. */
  isCrypto?: boolean;
}

/** Internal normalized shape — the union of `AttachmentRow` (plain path) and
 *  `ImapAttachment` (crypto path). Carries everything the chip + the download
 *  handler need; the two source types map into this at the boundary. */
interface DisplayedAttachment {
  /** Stable React key. */
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  /** Plain-path IMAP part id (`BODY[<part>]` selector); undefined on the
   *  crypto branch (downloads go by filename + contentId, not partId). */
  imapPartId?: string | null;
  /** Crypto branch: the original `ImapAttachment` for re-decrypt download. */
  crypto?: ImapAttachment;
}

export function AttachmentList({
  accountId,
  messageId,
  bodyHtml,
  decryptedAttachments,
  isCrypto,
}: AttachmentListProps) {
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // Reset the cached list when the target message changes — done at render
  // time (prev-value pattern), NOT in the effect, so eslint's
  // react-hooks/set-state-in-effect stays satisfied and there's no stale list
  // flash while the new fetch is in flight.
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(messageId);
  if (loadedFor !== messageId) {
    setLoadedFor(messageId);
    setAttachments([]);
  }

  useEffect(() => {
    // DA-Task 3: crypto branch sources its metadata from `decryptedAttachments`
    // (decrypted inner MIME) — skip the `db_get_attachments` call entirely.
    // Those rows describe the OUTER S/MIME envelope (`smime.p7m`), which is
    // useless to the user and filtered out by `CRYPTO_ENVELOPE_TYPES` anyway.
    if (isCrypto && decryptedAttachments && decryptedAttachments.length > 0) return;
    if (!accountId || !messageId) return;
    let cancelled = false;
    getAttachments(accountId, messageId)
      .then((rows) => {
        if (!cancelled) setAttachments(rows);
      })
      .catch((e) => console.error('[attachments] getAttachments failed', e));
    return () => {
      cancelled = true;
    };
  }, [accountId, messageId, isCrypto, decryptedAttachments]);

  // Hide attachments whose content_id is referenced inline by the body.
  const inlineCids = referencedCids(bodyHtml);
  // S/MIME crypto-structure parts are NOT user-facing attachments — they are
  // the envelope / detached signature the app decrypts / verifies internally:
  //   - `application/pkcs7-mime` → the `smime.p7m` envelope (enveloped-data
  //     or opaque signed-data). The decrypted body + inner attachments are
  //     surfaced separately; the raw envelope must never show as a chip.
  //   - `application/pkcs7-signature` → the detached `smime.p7s` of a
  //     clear-signed `multipart/signed` message.
  // (RFC 3851 names these; matching is case-insensitive.) A standalone .p7m
  // attached to a plain message would also be hidden — acceptable, since the
  // app treats any pkcs7-mime part as crypto structure to process, not to
  // hand to the user as a download.
  const CRYPTO_ENVELOPE_TYPES = new Set([
    'application/pkcs7-mime',
    'application/pkcs7-signature',
    'application/x-pkcs7-mime',
    'application/x-pkcs7-signature',
  ]);

  // DA-Task 3: build the displayed list from whichever source is authoritative
  // for this message kind. The crypto branch maps the snake_case `ImapAttachment`
  // shape to the internal `DisplayedAttachment`; the plain branch filters the
  // `AttachmentRow[]` returned by `db_get_attachments`.
  let displayed: DisplayedAttachment[];
  if (isCrypto && decryptedAttachments && decryptedAttachments.length > 0) {
    displayed = decryptedAttachments.map((a) => ({
      key: a.part_id,
      filename: a.filename,
      mimeType: a.mime_type,
      size: a.size,
      contentId: a.content_id ?? null,
      crypto: a,
    }));
  } else {
    displayed = attachments.map((a) => ({
      key: a.id,
      filename: a.filename ?? 'attachment',
      mimeType: a.mimeType ?? '',
      size: a.size,
      contentId: a.contentId ?? null,
      imapPartId: a.imapPartId,
    }));
  }

  const visible = displayed.filter((a) => {
    if (a.contentId && inlineCids.has(a.contentId)) return false;
    const mt = (a.mimeType ?? '').toLowerCase();
    if (mt && CRYPTO_ENVELOPE_TYPES.has(mt)) return false;
    return true;
  });
  if (visible.length === 0) return null;

  const handleDownload = async (att: DisplayedAttachment) => {
    if (!accountId || !messageId) return;
    const filename = att.filename || 'attachment';
    setBusy(att.key);
    try {
      const path = await save({
        defaultPath: filename,
        filters: [{ name: 'All Files', extensions: ['*'] }],
      });
      if (!path) return;
      let filePath: string;
      if (isCrypto) {
        // DA-Task 3: re-decrypt → write part to cache → return path. The
        // backend resolves the inner part by (filename, contentId), NOT by
        // IMAP partId (the envelope has only one IMAP part).
        const cached = await fetchCryptoAttachment(
          accountId,
          messageId,
          att.filename,
          att.contentId ?? null,
        );
        filePath = cached.filePath;
      } else {
        if (!att.imapPartId) return;
        const cached = await fetchAttachment(accountId, messageId, att.imapPartId);
        filePath = cached.filePath;
      }
      await invoke('copy_cached_attachment', { srcPath: filePath, destPath: path });
    } catch (e) {
      console.error('[attachments] download failed', e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {visible.map((att) => (
        <Button
          key={att.key}
          onPress={() => void handleDownload(att)}
          isDisabled={busy !== null}
          aria-label={att.filename}
          className="group flex max-w-full items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs transition-colors hover:bg-[var(--hover)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Paperclip size={13} className="shrink-0 text-[var(--muted-text)]" />
          <span className="max-w-[180px] truncate text-[var(--foreground)]">{att.filename}</span>
          {att.size > 0 && (
            <span className="shrink-0 text-[var(--muted-text)]">{formatFileSize(att.size)}</span>
          )}
          {busy === att.key && <span className="shrink-0 text-[var(--muted-text)]">…</span>}
        </Button>
      ))}
    </div>
  );
}
