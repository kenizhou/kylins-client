// Shared draft-session model for the two compose surfaces (the reading-pane
// dock via inlineComposerStore, the OS compose window via composerStore).
//
// Both surfaces edit the same conceptual thing — a DraftSessionFields bag —
// and both persist it to `local_drafts` through the SAME mapper here. Before
// this extraction each surface had its own state→DraftInput mapping and the
// window's silently dropped classification, encrypt/sign, importance,
// receipts, deliverAt, preventCopy, and replyTo on every save (save → resume
// lost the flags). One mapper, no drift.

import type { Recipient } from '@/features/composer/contacts';
import type { Importance } from '@/stores/composerStore';
import type { DraftInput, StoredAttachment } from '@/services/composer/drafts';

/** Path-backed attachment ref (identical shape to StoredAttachment). */
export type DraftSessionAttachment = StoredAttachment;

/** The canonical editable-draft field set, embedded by both compose stores. */
export interface DraftSessionFields {
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  replyTo: Recipient[];
  subject: string;
  bodyHtml: string | null;
  fromEmail: string | null;
  threadId: string | null;
  inReplyToMessageId: string | null;
  signatureId: string | null | undefined;
  attachments: DraftSessionAttachment[];
  classificationId: string | null;
  isEncrypted: boolean;
  isSigned: boolean;
  importance: Importance;
  requestReadReceipt: boolean;
  requestDeliveryReceipt: boolean;
  deliverAt: number | null;
  preventCopy: boolean;
  /** Compose intent ('new' | 'reply' | 'replyAll' | 'forward' |
   *  with-attachments variants). The dock persists its exact intent; the OS
   *  compose window maps its `mode` here. */
  intent: string;
  /** Source message for reply/forward attachment seeding + forward chrome. */
  originalMessageId: string | null;
  includeOriginalAttachments: boolean;
}

/** Map the shared session fields to a persistable DraftInput. */
export function draftSessionToDraftInput(
  fields: DraftSessionFields,
  accountId: string,
): DraftInput {
  return {
    accountId,
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    replyTo: fields.replyTo,
    subject: fields.subject,
    bodyHtml: fields.bodyHtml ?? '',
    fromEmail: fields.fromEmail,
    threadId: fields.threadId,
    inReplyToMessageId: fields.inReplyToMessageId,
    signatureId: fields.signatureId,
    attachments: fields.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      filePath: a.filePath,
      size: a.size,
    })),
    classificationId: fields.classificationId,
    isEncrypted: fields.isEncrypted,
    isSigned: fields.isSigned,
    importance: fields.importance,
    requestReadReceipt: fields.requestReadReceipt,
    requestDeliveryReceipt: fields.requestDeliveryReceipt,
    deliverAt: fields.deliverAt,
    preventCopy: fields.preventCopy,
    intent: fields.intent,
    originalMessageId: fields.originalMessageId,
    includeOriginalAttachments: fields.includeOriginalAttachments,
  };
}

/** Full-field change detection for the autosave content gate. Identity
 *  compares (both compose stores replace arrays rather than mutate them).
 *  Compares EVERY persisted field on purpose: a toggle that never schedules
 *  a save is a toggle whose change is lost when the composer closes — the
 *  pre-unification window mapper had exactly that bug. */
export function draftSessionContentChanged(a: DraftSessionFields, b: DraftSessionFields): boolean {
  return (
    a.bodyHtml !== b.bodyHtml ||
    a.subject !== b.subject ||
    a.to !== b.to ||
    a.cc !== b.cc ||
    a.bcc !== b.bcc ||
    a.replyTo !== b.replyTo ||
    a.attachments !== b.attachments ||
    a.classificationId !== b.classificationId ||
    a.importance !== b.importance ||
    a.isEncrypted !== b.isEncrypted ||
    a.isSigned !== b.isSigned ||
    a.requestReadReceipt !== b.requestReadReceipt ||
    a.requestDeliveryReceipt !== b.requestDeliveryReceipt ||
    a.deliverAt !== b.deliverAt ||
    a.preventCopy !== b.preventCopy ||
    a.fromEmail !== b.fromEmail ||
    a.signatureId !== b.signatureId ||
    a.threadId !== b.threadId ||
    a.inReplyToMessageId !== b.inReplyToMessageId ||
    a.intent !== b.intent ||
    a.originalMessageId !== b.originalMessageId ||
    a.includeOriginalAttachments !== b.includeOriginalAttachments
  );
}
