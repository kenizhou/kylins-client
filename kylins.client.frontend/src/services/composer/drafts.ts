// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Local-first draft persistence over the `local_drafts` table (migration v17).
// velo stores drafts server-side via the provider (Gmail API); Kylins persists
// the editable draft locally first and reserves `remote_draft_id` for future
// server-side draft sync. Raw MIME is built only at send time (see send.ts).
//
// Task 5 (Option C) clean-cut cutover: every function delegates to a Rust
// `db_*` Tauri command (see `kylins.client.backend/src/db/drafts.rs`). The
// recipient formatting + attachment serialization stays TS-side (the composer
// does this before calling); Rust receives pre-serialized JSON strings for the
// to/cc/bcc/attachments columns, exactly as the historical code wrote them.

import { invoke } from '@tauri-apps/api/core';
import { formatRecipients, type Recipient } from '@/features/composer/contacts';

/**
 * Serializable attachment shape stored in `local_drafts.attachments` as JSON.
 * The live composer attachment (`ComposerAttachment`) also carries a `File`
 * handle which is not JSON-serializable, so it is dropped at the boundary.
 */
export interface StoredAttachment {
  filename: string;
  mimeType: string;
  content: string; // base64
  size: number;
}

/** Editable draft fields, matching the composer store shape. */
export interface DraftInput {
  accountId: string;
  to: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  replyTo?: Recipient[];
  subject: string;
  bodyHtml: string;
  fromEmail?: string | null;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  signatureId?: string | null;
  attachments?: StoredAttachment[];
  classificationId?: string | null;
  isEncrypted?: boolean;
  isSigned?: boolean;
}

/** Raw `local_drafts` row. Array/attachment columns are JSON-encoded strings. */
export interface DbDraft {
  id: string;
  account_id: string;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  subject: string | null;
  body_html: string | null;
  reply_to_message_id: string | null;
  thread_id: string | null;
  from_email: string | null;
  signature_id: string | null;
  remote_draft_id: string | null;
  attachments: string | null;
  classification_id: string | null;
  is_encrypted: number;
  is_signed: number;
  created_at: number;
  updated_at: number;
  sync_status: string;
}

/**
 * Build the Rust-facing payload from a TS `DraftInput`. Recipients are
 * serialized as JSON arrays of RFC address strings ("Name <email>"); empty
 * cc/bcc/attachments become null (matching the historical `inputToColumns`).
 */
function toRustInput(input: DraftInput) {
  return {
    accountId: input.accountId,
    // to_addresses is always a non-empty array (composer always has at least the To box)
    to: JSON.stringify(formatRecipients(input.to ?? [])),
    cc: input.cc && input.cc.length > 0 ? JSON.stringify(formatRecipients(input.cc)) : null,
    bcc: input.bcc && input.bcc.length > 0 ? JSON.stringify(formatRecipients(input.bcc)) : null,
    subject: input.subject ?? '',
    bodyHtml: input.bodyHtml ?? '',
    fromEmail: input.fromEmail ?? null,
    threadId: input.threadId ?? null,
    replyToMessageId: input.inReplyToMessageId ?? null,
    signatureId: input.signatureId ?? null,
    attachments:
      input.attachments && input.attachments.length > 0 ? JSON.stringify(input.attachments) : null,
    classificationId: input.classificationId ?? null,
    isEncrypted: input.isEncrypted ?? false,
    isSigned: input.isSigned ?? false,
  };
}

export async function createDraft(input: DraftInput): Promise<string> {
  return invoke<string>('db_create_draft', { input: toRustInput(input) });
}

export async function updateDraft(id: string, input: DraftInput): Promise<void> {
  await invoke<void>('db_update_draft', { id, input: toRustInput(input) });
}

/**
 * Create or update a draft. If `existingId` refers to an existing row, update
 * it in place; otherwise insert a new row. Returns the persisted draft id.
 */
export async function saveDraft(input: DraftInput, existingId?: string | null): Promise<string> {
  if (existingId) {
    const existing = await getDraft(existingId);
    if (existing) {
      await updateDraft(existingId, input);
      return existingId;
    }
  }
  return createDraft(input);
}

export async function deleteDraft(id: string): Promise<void> {
  await invoke<void>('db_delete_draft', { id });
}

export async function getDraft(id: string): Promise<DbDraft | null> {
  return invoke<DbDraft | null>('db_get_draft', { id });
}

export async function listDraftsForAccount(accountId: string): Promise<DbDraft[]> {
  return invoke<DbDraft[]>('db_list_drafts_for_account', { accountId });
}
