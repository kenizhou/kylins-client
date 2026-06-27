// Composer-scoped send orchestration for Kylins Client.
//
// Sends are routed through the Rust sync engine via the `sync_apply_mutation`
// Tauri command. The engine applies locally (a no-op for Send — there is no
// message row yet) and enqueues a single `send:{uuid}` pending row that the
// replay worker transmits via `MailSource::send` (SMTP for IMAP-style accounts,
// EAS SendMail for Exchange) with exponential backoff. The invoke resolving
// means "queued for send"; the UI treats that as success.
//
// Previously this module did the SMTP/EAS transport inline + fell back to the
// JS offline queue on network error. That responsibility now lives in the
// engine, so the per-provider transports (`smtpSender`, `imapProvider`,
// `easProvider`) and the JS `OfflineQueue` are no longer referenced here —
// they remain in the tree as the engine's `MailSource` implementations.

import { invoke } from '@tauri-apps/api/core';
import { deleteDraft, type DraftInput } from './drafts';
import { inlineCss } from './juiceInline';
import { buildRawEmail, type EmailAttachment } from '@/utils/emailBuilder';
import { useAccountStore } from '@/stores/accountStore';
import { formatRecipients } from '@/features/composer/contacts';
import { stripSignature } from '@/features/composer/signaturePlacement';

export interface SendResult {
  success: boolean;
  message: string;
}

/** Dispatched on a successful send so the UI can refresh the Sent folder. */
export const SEND_COMPLETE_EVENT = 'mail:send-complete';

/** Map a DraftInput to the shape `buildRawEmail` expects. */
function inputToEmailDraft(input: DraftInput, fallbackFrom: string) {
  const attachments: EmailAttachment[] = (input.attachments ?? []).map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    content: a.content,
  }));
  // Recipient[] → RFC address strings at the MIME boundary. Reply-To only when set.
  const replyTo =
    input.replyTo && input.replyTo.length > 0 ? formatRecipients(input.replyTo) : undefined;
  return {
    from: input.fromEmail ?? fallbackFrom,
    to: formatRecipients(input.to),
    cc: input.cc && input.cc.length > 0 ? formatRecipients(input.cc) : undefined,
    bcc: input.bcc && input.bcc.length > 0 ? formatRecipients(input.bcc) : undefined,
    replyTo,
    subject: input.subject,
    // Inline <style> blocks for email-client fidelity, then unwrap any baked-in
    // <signature> tag so recipients see the signature content without the
    // non-standard wrapper element.
    htmlBody: stripSignature(inlineCss(input.bodyHtml)),
    inReplyTo: input.inReplyToMessageId ?? undefined,
    threadId: input.threadId ?? undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/**
 * Send a draft. Builds the raw MIME, then enqueues it through the sync engine
 * via `sync_apply_mutation` (`{ type: 'send', rawBase64url }`). The engine
 * owns the actual transport + retry; this function treats the invoke resolve
 * as "queued/sent". On success, deletes the persisted draft (if `draftId` is
 * given) and dispatches {@link SEND_COMPLETE_EVENT} so the UI refreshes the
 * Sent folder. On invoke failure, keeps the draft and returns a structured
 * `success: false` result — the engine does NOT auto-retry a failed enqueue,
 * so the user can retry explicitly.
 */
export async function sendEmail(
  accountId: string,
  input: DraftInput,
  draftId?: string | null,
): Promise<SendResult> {
  const account = useAccountStore.getState().accounts.find((a) => a.id === accountId);
  if (!account) {
    return { success: false, message: `No account found for id ${accountId}` };
  }

  const rawBase64Url = buildRawEmail(inputToEmailDraft(input, account.email));

  let result: SendResult;
  try {
    await invoke('sync_apply_mutation', {
      accountId,
      op: { type: 'send', rawBase64url: rawBase64Url },
    });
    result = { success: true, message: 'Queued for send' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }

  if (!result.success) {
    return result;
  }

  if (draftId) {
    await deleteDraft(draftId);
  }
  window.dispatchEvent(new Event(SEND_COMPLETE_EVENT));
  return result;
}
