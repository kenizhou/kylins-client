// Saved-draft surfacing for the Drafts folder.
//
// Drafts persist locally in the `local_drafts` table (local-first — see
// `services/composer/drafts.ts`). This module maps the raw rows into the
// message-list view model, opens them in the OS compose window, and provides
// the delete path (row + staged attachment files). The low-level DbDraft→
// fields mapping lives in `features/drafts/draftMapping.ts` (re-exported
// here for convenience).

import { deleteDraft, listDraftsForAccount, type DbDraft } from '@/services/composer/drafts';
import { cleanupAttachments } from '@/services/composer/attachments';
import { formatRecipients } from '@/features/composer/contacts';
import { openComposerWindow, type ComposeWindowOptions } from '@/utils/composeWindow';
import { useInlineComposerStore } from '@/stores/inlineComposerStore';
import type { Thread } from '@/services/db/threads';
import {
  dbDraftRecipients,
  dbDraftToComposerAttachments,
  dbDraftToDraftSessionFields,
  stagingIdFromAttachmentPath,
  storedAttachments,
} from './draftMapping';
import {
  intentFamily,
  intentIncludesAttachments,
  type InlineIntent,
} from '@/features/composer/draftFactory';
import type { ComposerMode } from '@/stores/composerStore';

export {
  dbDraftRecipients,
  dbDraftToComposerAttachments,
  dbDraftToDraftSessionFields,
  stagingIdFromAttachmentPath,
  storedAttachments,
} from './draftMapping';

/**
 * Newest saved draft linked to a conversation (thread rows are already
 * ordered updated_at DESC by the backend query). Used by the reading pane to
 * resume a persisted inline draft after an app reload.
 */
export async function findDraftForThread(
  accountId: string,
  threadId: string,
): Promise<DbDraft | null> {
  const rows = await listDraftsForAccount(accountId);
  return (rows ?? []).find((r) => r.thread_id === threadId) ?? null;
}

/** One-line plain-text preview of the draft body for the snippet column. */
export function htmlToSnippet(html: string | null): string {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sender-column stand-in for a draft: the intended recipients (Outlook-style). */
export function recipientSummary(d: DbDraft): string {
  const to = dbDraftRecipients(d).to;
  if (to.length > 0) return formatRecipients(to).join(', ');
  return '(no recipients)';
}

/** Row id prefix so draft rows can never collide with a real thread id. */
export const LOCAL_DRAFT_ROW_PREFIX = 'local-draft:';

/**
 * Project a saved draft into the Thread shape MessageRow renders. The row is
 * display-only: `isRead` is pinned true and `id` is prefixed so thread-scoped
 * store actions (which the list never wires to draft rows) could not target a
 * real conversation by accident.
 */
export function draftToThread(d: DbDraft): Thread {
  return {
    id: `${LOCAL_DRAFT_ROW_PREFIX}${d.id}`,
    accountId: d.account_id,
    subject: d.subject || '(no subject)',
    snippet: htmlToSnippet(d.body_html) || null,
    lastMessageAt: d.updated_at > 0 ? d.updated_at : null,
    messageCount: 1,
    isRead: true,
    isStarred: false,
    isImportant: d.importance === 'high',
    hasAttachments: storedAttachments(d).length > 0,
    isSnoozed: false,
    fromName: recipientSummary(d),
    fromAddress: null,
    classificationId: d.classification_id,
    isEncrypted: !!d.is_encrypted,
    isSigned: !!d.is_signed,
  };
}

/** Map a persisted draft row into `ComposeWindowOptions` for the OS composer
 *  window (double-click on a Drafts row). The window hydrates composerStore
 *  from these params and its autosave keeps updating the SAME row id. Mode
 *  comes from the persisted intent (a forward draft reopens as a forward);
 *  pre-intent-column rows fall back to the threading-column heuristic. */
export function draftToComposeWindowOptions(d: DbDraft): ComposeWindowOptions {
  const f = dbDraftToDraftSessionFields(d);
  const attachments = dbDraftToComposerAttachments(d);
  const stagingDraftId =
    attachments.length > 0
      ? (stagingIdFromAttachmentPath(attachments[0]!.filePath) ?? undefined)
      : undefined;
  const mode: ComposerMode = f.intent === 'new' ? 'new' : intentFamily(f.intent as InlineIntent);
  return {
    mode,
    to: f.to,
    cc: f.cc,
    bcc: f.bcc,
    replyTo: f.replyTo,
    subject: f.subject,
    bodyHtml: f.bodyHtml ?? '',
    accountId: d.account_id,
    threadId: f.threadId,
    inReplyToMessageId: f.inReplyToMessageId,
    draftId: d.id,
    fromEmail: f.fromEmail,
    signatureId: f.signatureId,
    classificationId: f.classificationId,
    isEncrypted: f.isEncrypted,
    isSigned: f.isSigned,
    importance: f.importance,
    requestReadReceipt: f.requestReadReceipt,
    requestDeliveryReceipt: f.requestDeliveryReceipt,
    deliverAt: f.deliverAt,
    preventCopy: f.preventCopy,
    originalMessageId: f.originalMessageId,
    includeOriginalAttachments:
      f.includeOriginalAttachments || intentIncludesAttachments(f.intent as InlineIntent),
    stagingDraftId,
    attachments,
  };
}

/**
 * Open a saved draft in the OS composer window (double-click path). When the
 * draft is live in the dock, transfer it instead (pop-out hands over the
 * staging directory and deletes the old row so the two surfaces never write
 * the same `local_drafts` row concurrently).
 */
export function openDraftInWindow(d: DbDraft): void {
  const session = useInlineComposerStore.getState().session;
  if (session?.draftId === d.id) {
    useInlineComposerStore.getState().popOut(session.bodyHtml ?? '', session.signatureId);
    return;
  }
  void openComposerWindow(draftToComposeWindowOptions(d));
}

/**
 * Delete a saved draft: the `local_drafts` row plus its staged attachment
 * directory (best-effort — a deleted draft never reaches the backend's
 * send-time cleanup). The `DRAFTS_CHANGED_EVENT` fired by `deleteDraft`
 * refreshes any open Drafts folder view.
 */
export async function deleteLocalDraft(d: DbDraft): Promise<void> {
  await deleteDraft(d.id);
  const atts = storedAttachments(d);
  const stagingId = atts.length > 0 ? stagingIdFromAttachmentPath(atts[0]!.filePath) : null;
  if (stagingId) {
    try {
      await cleanupAttachments(stagingId);
    } catch (e) {
      console.warn('[drafts] staged attachment cleanup failed (best-effort)', e);
    }
  }
}
