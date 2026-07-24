// Low-level DbDraft → editable-fields mapping, shared by every draft resume
// path (the inline dock's session builder, the OS compose window's param
// builder, and the Drafts-folder view models in localDrafts.ts).
//
// Extracted from localDrafts.ts so both it and inlineComposerStore.ts can
// import the helpers WITHOUT a cycle (the store previously imported them from
// localDrafts while localDrafts wanted the store for the pop-out transfer).

import { parseRecipients, type Recipient } from '@/features/composer/contacts';
import { newAttachmentId } from '@/services/composer/attachments';
import type { DbDraft, StoredAttachment } from '@/services/composer/drafts';
import type { DraftSessionFields } from '@/features/composer/draftSession';
import type { ComposerAttachment, Importance } from '@/stores/composerStore';

/** Parse a JSON recipient column ("Name <email>" strings) into raw strings. */
function parseAddressColumn(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr: unknown = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Parse the JSON attachments column. Tolerates legacy/corrupt rows. */
export function storedAttachments(d: DbDraft): StoredAttachment[] {
  if (!d.attachments) return [];
  try {
    const arr: unknown = JSON.parse(d.attachments);
    return Array.isArray(arr) ? (arr as StoredAttachment[]) : [];
  } catch {
    return [];
  }
}

/** Recipients from the JSON columns, parsed into structured chips. */
export function dbDraftRecipients(d: DbDraft): {
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  replyTo: Recipient[];
} {
  const parse = (json: string | null) => {
    const raw = parseAddressColumn(json).join(', ');
    return raw ? parseRecipients(raw) : [];
  };
  return {
    to: parse(d.to_addresses),
    cc: parse(d.cc_addresses),
    bcc: parse(d.bcc_addresses),
    replyTo: parse(d.reply_to_addresses),
  };
}

/** Attachments re-hydrated as composer chips (fresh UI ids, same file paths). */
export function dbDraftToComposerAttachments(d: DbDraft): ComposerAttachment[] {
  return storedAttachments(d).map((a) => ({
    id: newAttachmentId(),
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    filePath: a.filePath,
    origin: 'picked',
  }));
}

/**
 * Recover the staging directory name from a staged attachment path
 * (`<appData>/outbox-attachments/{stagingDraftId}/{filename}`). Reusing it as
 * the composer's `stagingDraftId` on resume keeps new picks, re-saves, and the
 * backend's send-time cleanup all pointed at the SAME directory — no orphaned
 * outbox dirs from the save → resume → send round-trip.
 */
export function stagingIdFromAttachmentPath(filePath: string): string | null {
  const parts = filePath.split(/[\\/]/);
  const i = parts.lastIndexOf('outbox-attachments');
  if (i < 0) return null;
  return parts[i + 1] ?? null;
}

/** Intent values the dock + window know how to resume. Anything else (NULL
 *  rows predating the column, future values) falls back to deriving from the
 *  threading columns, the pre-intent-column behavior. */
const VALID_INTENTS = new Set([
  'new',
  'reply',
  'replyAll',
  'forward',
  'replyWithAttachments',
  'replyAllWithAttachments',
]);

/** Persisted intent with fallback for pre-column rows. */
export function dbDraftIntent(d: DbDraft): string {
  if (d.intent && VALID_INTENTS.has(d.intent)) return d.intent;
  return d.reply_to_message_id ? 'reply' : 'new';
}

/** Map a persisted row to the canonical editable-fields bag. The single
 *  source for DbDraft→fields mapping — the inline session builder and the
 *  compose-window param builder both layer on top of this. */
export function dbDraftToDraftSessionFields(d: DbDraft): DraftSessionFields {
  const { to, cc, bcc, replyTo } = dbDraftRecipients(d);
  return {
    to,
    cc,
    bcc,
    replyTo,
    subject: d.subject ?? '',
    bodyHtml: d.body_html ?? '',
    fromEmail: d.from_email,
    threadId: d.thread_id,
    inReplyToMessageId: d.reply_to_message_id,
    signatureId: d.signature_id,
    attachments: storedAttachments(d),
    classificationId: d.classification_id,
    isEncrypted: !!d.is_encrypted,
    isSigned: !!d.is_signed,
    importance: (d.importance as Importance | null) ?? 'normal',
    requestReadReceipt: !!d.request_read_receipt,
    requestDeliveryReceipt: !!d.request_delivery_receipt,
    deliverAt: d.deliver_at,
    preventCopy: !!d.prevent_copy,
    intent: dbDraftIntent(d),
    originalMessageId: d.original_message_id,
    includeOriginalAttachments: !!d.include_original_attachments,
  };
}
