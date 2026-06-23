// Composer-scoped send orchestration for Kylins Client.
//
// velo routes sends through a monolithic `emailActions.executeEmailAction` that
// is coupled to threadStore / providerFactory / pendingOperations /
// networkErrors / router — none of which exist in Kylins yet. This module
// implements a focused send path instead:
//
//   DraftInput → build raw MIME → route to the account's transport
//   (SMTP for IMAP-style accounts, EAS SendMail for Exchange) → on a network
//   error enqueue to the offline queue, on success delete the local draft.
//
// TODO: replace per-call `new ImapProvider/EasProvider` with a providerFactory
// once one exists (mirroring velo's providerFactory).

import type { Account } from '../../types';
import { deleteDraft, type DraftInput } from './drafts';
import { inlineCss } from './juiceInline';
import { buildRawEmail, type EmailAttachment } from '@/utils/emailBuilder';
import { useAccountStore } from '@/stores/accountStore';
import { OfflineQueue } from '@/services/queue/offlineQueue';
import { sendEmail as smtpSendEmail } from '@/services/mail/smtpSender';
import { ImapProvider } from '@/services/mail/imapProvider';
import { EasProvider } from '@/services/mail/easProvider';

export interface SendResult {
  success: boolean;
  message: string;
}

/** Dispatched on a successful send so the UI can refresh the Sent folder. */
export const SEND_COMPLETE_EVENT = 'mail:send-complete';

/** EAS SendMail status code for success (per MS-ASCMD). */
const EAS_STATUS_SUCCESS = 1;

/**
 * Best-effort Sent-folder name for IMAP append. TODO: resolve the correct Sent
 * folder per-account (e.g. "Sent", "Sent Items", "INBOX.Sent") via folder sync.
 */
const IMAP_SENT_FOLDER = 'Sent';

// Module-level offline queue (the table is the source of truth).
const offlineQueue = new OfflineQueue();

/** Convert base64url → standard base64 (swap charset, restore padding). */
function base64UrlToBase64(b64url: string): string {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return b64;
}

/** Decode a base64url string back to its original UTF-8 string (raw MIME). */
function base64UrlDecodeToString(b64url: string): string {
  const binary = atob(base64UrlToBase64(b64url));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Map a DraftInput to the shape `buildRawEmail` expects. */
function inputToEmailDraft(input: DraftInput, fallbackFrom: string) {
  const attachments: EmailAttachment[] = (input.attachments ?? []).map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    content: a.content,
  }));
  return {
    from: input.fromEmail ?? fallbackFrom,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    // Inline <style> blocks into element-level styles for email-client fidelity.
    htmlBody: inlineCss(input.bodyHtml),
    inReplyTo: input.inReplyToMessageId ?? undefined,
    threadId: input.threadId ?? undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/** Send via SMTP, then best-effort append to the Sent folder over IMAP. */
async function sendViaSmtp(account: Account, rawBase64Url: string): Promise<SendResult> {
  const result = await smtpSendEmail(account, rawBase64Url);
  if (!result.success) {
    return result;
  }

  // Many servers auto-save to Sent on SMTP submit; this covers those that do
  // not. Failures here are non-fatal — the message was already accepted.
  if (account.imapHost) {
    try {
      const rawMime = base64UrlDecodeToString(rawBase64Url);
      // TODO: resolve the correct Sent folder per-account instead of "Sent".
      const imap = new ImapProvider(account);
      await imap.appendMessage(IMAP_SENT_FOLDER, rawMime, '\\Seen');
    } catch (err) {
      console.warn('[composer] save-to-Sent failed (non-fatal):', err);
    }
  }

  return result;
}

/** Send via Exchange ActiveSync (server saves to Sent via save_to_sent). */
async function sendViaEas(account: Account, rawBase64Url: string): Promise<SendResult> {
  if (!account.easUrl || !account.easDeviceId) {
    return {
      success: false,
      message: 'EAS account is not fully configured (missing URL or device id)',
    };
  }
  const eas = new EasProvider(account);
  const mimeBase64 = base64UrlToBase64(rawBase64Url);
  const status = await eas.sendMail({ mime_base64: mimeBase64, save_to_sent: true });
  if (status !== EAS_STATUS_SUCCESS) {
    return { success: false, message: `EAS SendMail failed with status ${status}` };
  }
  return { success: true, message: 'Sent via Exchange ActiveSync' };
}

/**
 * Send a draft. Routes to SMTP (IMAP-style accounts) or EAS (Exchange) based on
 * `account.provider`. On success, deletes the persisted draft (if `draftId` is
 * given) and dispatches {@link SEND_COMPLETE_EVENT}. On a transport/network
 * error, keeps the draft and enqueues a `sendMessage` operation to the offline
 * queue for later retry (the queue processor is still TODO). A structured
 * `success: false` result (e.g. auth rejection) is returned without enqueuing,
 * since it is unlikely to succeed on blind retry.
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
    result =
      account.provider === 'eas'
        ? await sendViaEas(account, rawBase64Url)
        : await sendViaSmtp(account, rawBase64Url);
  } catch (err) {
    // Transport/network error — keep the draft and retry from the offline queue.
    await offlineQueue.enqueue({
      accountId,
      operationType: 'sendMessage',
      resourceId: draftId ?? input.subject ?? crypto.randomUUID(),
      params: { draftId: draftId ?? null },
    });
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
