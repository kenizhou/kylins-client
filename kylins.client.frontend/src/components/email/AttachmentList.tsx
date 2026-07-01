// Attachment list for the reading pane. Lists the non-inline attachments for a
// message (paperclip chips with filename + size); click to download via a save
// dialog. Inline `cid:` images are excluded here because they render in-body
// (resolved by ReadingPane's cidMap → EmailRenderer).
//
// Metadata comes from `db_get_attachments` (persisted by the body-fetch path).
// Bytes come from `sync_fetch_attachment` (raw IMAP `BODY.PEEK[]` + part
// extract) and are written via the `write_binary_file` command (the app does
// not bundle the @tauri-apps/plugin-fs JS package).

import { useEffect, useState } from 'react';
import { Paperclip } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import {
  type AttachmentRow,
  fetchAttachment,
  getAttachments,
  referencedCids,
} from '../../services/db/attachments';
import { formatFileSize } from '../../utils/fileTypeHelpers';

interface AttachmentListProps {
  accountId: string | null | undefined;
  messageId: string | null | undefined;
  /** Body HTML, used to detect which attachments are referenced by `cid:`
   *  inline and should be hidden from this list. */
  bodyHtml: string | null | undefined;
}

export function AttachmentList({ accountId, messageId, bodyHtml }: AttachmentListProps) {
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
  }, [accountId, messageId]);

  // Hide attachments whose content_id is referenced inline by the body.
  const inlineCids = referencedCids(bodyHtml);
  const visible = attachments.filter((a) => !a.contentId || !inlineCids.has(a.contentId));
  if (visible.length === 0) return null;

  const handleDownload = async (att: AttachmentRow) => {
    if (!att.imapPartId || !accountId || !messageId) return;
    const filename = att.filename ?? 'attachment';
    setBusy(att.id);
    try {
      const path = await save({
        defaultPath: filename,
        filters: [{ name: 'All Files', extensions: ['*'] }],
      });
      if (!path) return;
      const { base64 } = await fetchAttachment(accountId, messageId, att.imapPartId);
      await invoke('write_binary_file', { path, dataBase64: base64 });
    } catch (e) {
      console.error('[attachments] download failed', e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {visible.map((att) => (
        <button
          key={att.id}
          type="button"
          onClick={() => void handleDownload(att)}
          disabled={busy !== null}
          title={att.filename ?? 'attachment'}
          className="group flex max-w-full items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs transition-colors hover:bg-[var(--hover)] disabled:opacity-60"
        >
          <Paperclip size={13} className="shrink-0 text-[var(--muted-text)]" />
          <span className="max-w-[180px] truncate text-[var(--foreground)]">
            {att.filename ?? 'attachment'}
          </span>
          {att.size > 0 && (
            <span className="shrink-0 text-[var(--muted-text)]">{formatFileSize(att.size)}</span>
          )}
          {busy === att.id && <span className="shrink-0 text-[var(--muted-text)]">…</span>}
        </button>
      ))}
    </div>
  );
}
