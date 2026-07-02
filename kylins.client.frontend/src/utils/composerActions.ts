import type { MailMessage } from '../features/view/viewStore';
import type { Thread } from '../services/db/threads';
import { getMessagesForThread, mapMessageToMailMessage } from '../services/db/threads';
import { getMessageBody } from '../services/db/messageBodies';
import { openComposerWindow } from './composeWindow';

export type ComposerMode = 'reply' | 'replyAll' | 'forward';

const COMPOSER_FN: Record<ComposerMode, (message: MailMessage, fromEmail: string | null) => void> =
  {
    reply: openReplyComposer,
    replyAll: openReplyAllComposer,
    forward: openForwardComposer,
  };

function baseReplyInput(message: MailMessage, fromEmail: string | null) {
  return {
    threadId: message.threadId ?? message.id,
    fromEmail,
    subject: message.subject,
    inReplyToMessageId: message.messageId ?? null,
    classificationId: message.classificationId ?? undefined,
    isEncrypted: message.isEncrypted,
    isSigned: message.isSigned,
  };
}

/**
 * Shared modal-composer entry points for reply / reply-all / forward.
 *
 * The modal composer seeds its editor from the passed `threadId` + body on
 * pop-out; in the current skeleton it only receives the metadata it needs to
 * identify the original message. Callers in the message list / ribbon / reading
 * pane all use these helpers so the payload shape stays consistent.
 */

export function openReplyComposer(message: MailMessage, fromEmail: string | null): void {
  void openComposerWindow({
    mode: 'reply',
    ...baseReplyInput(message, fromEmail),
  });
}

export function openReplyAllComposer(message: MailMessage, fromEmail: string | null): void {
  void openComposerWindow({
    mode: 'replyAll',
    ...baseReplyInput(message, fromEmail),
  });
}

export function openForwardComposer(message: MailMessage, fromEmail: string | null): void {
  void openComposerWindow({
    mode: 'forward',
    ...baseReplyInput(message, fromEmail),
  });
}

export function openReplyComposerWithAttachments(
  message: MailMessage,
  fromEmail: string | null,
): void {
  void openComposerWindow({
    mode: 'reply',
    ...baseReplyInput(message, fromEmail),
    originalMessageId: message.id,
    includeOriginalAttachments: true,
  });
}

export function openReplyAllComposerWithAttachments(
  message: MailMessage,
  fromEmail: string | null,
): void {
  void openComposerWindow({
    mode: 'replyAll',
    ...baseReplyInput(message, fromEmail),
    originalMessageId: message.id,
    includeOriginalAttachments: true,
  });
}

export function openForwardComposerAsAttachment(
  message: MailMessage,
  fromEmail: string | null,
): void {
  void openComposerWindow({
    mode: 'forward',
    ...baseReplyInput(message, fromEmail),
    originalMessageId: message.id,
    forwardAsAttachment: true,
    originalMessageSubject: message.subject,
    originalMessageHtml: message.html,
    originalMessageText: message.text,
  });
}

/**
 * Fetch the latest message for a thread (plus its HTML body) and open the modal
 * composer in reply / reply-all / forward mode. Centralizes the DB lookup glue
 * so components don't duplicate it.
 */
export async function openComposerForThread(
  thread: Thread,
  mode: ComposerMode,
  accountEmail: string | null,
): Promise<void> {
  const msgs = await getMessagesForThread(thread.accountId, thread.id);
  const latest = msgs[msgs.length - 1];
  if (!latest) return;
  const body = await getMessageBody(thread.accountId, latest.id);
  const message = mapMessageToMailMessage(latest, body?.bodyHtml ?? null);
  COMPOSER_FN[mode](message, accountEmail);
}
