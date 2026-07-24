import type { Account } from '@/types';
import type { MailMessage } from '../features/view/viewStore';
import type { Thread } from '../services/db/threads';
import { getMessagesForThread, mapMessageToMailMessage } from '../services/db/threads';
import { getMessageBody } from '../services/db/messageBodies';
import { openComposerWindow } from './composeWindow';
import {
  buildComposerOpenOptions,
  type ComposerOpenMode,
} from '../features/composer/buildComposerOpenOptions';

// Reply/forward helpers that open the dedicated OS composer window.
// Post drafting-flow redesign these are used from surfaces that have no
// reading-pane dock: the viewer pop-out window and forward-as-attachment.
// Main-window replies dock the inline composer instead (ReadRibbon /
// MessageList call inlineComposerStore.open directly).

export type ComposerMode = ComposerOpenMode;

export type ComposerAccountInfo = Pick<Account, 'id' | 'email' | 'displayName'>;

async function openModeComposer(
  message: MailMessage,
  account: ComposerAccountInfo,
  mode: ComposerMode,
  extra?: { includeOriginalAttachments?: boolean; forwardAsAttachment?: boolean },
): Promise<void> {
  const opts = await buildComposerOpenOptions({
    account,
    message,
    mode,
    includeOriginalAttachments: extra?.includeOriginalAttachments,
    forwardAsAttachment: extra?.forwardAsAttachment,
  });
  openComposerWindow(opts);
}

export function openReplyComposer(message: MailMessage, account: ComposerAccountInfo): void {
  void openModeComposer(message, account, 'reply');
}

export function openReplyAllComposer(message: MailMessage, account: ComposerAccountInfo): void {
  void openModeComposer(message, account, 'replyAll');
}

export function openForwardComposer(message: MailMessage, account: ComposerAccountInfo): void {
  void openModeComposer(message, account, 'forward');
}

export function openReplyComposerWithAttachments(
  message: MailMessage,
  account: ComposerAccountInfo,
): void {
  void openModeComposer(message, account, 'reply', { includeOriginalAttachments: true });
}

export function openReplyAllComposerWithAttachments(
  message: MailMessage,
  account: ComposerAccountInfo,
): void {
  void openModeComposer(message, account, 'replyAll', { includeOriginalAttachments: true });
}

export function openForwardComposerAsAttachment(
  message: MailMessage,
  account: ComposerAccountInfo,
): void {
  void openModeComposer(message, account, 'forward', { forwardAsAttachment: true });
}

/**
 * Fetch the latest message for a thread (plus its HTML body) and open the modal
 * composer in reply / reply-all / forward mode. Centralizes the DB lookup glue
 * so components don't duplicate it.
 */
export async function openComposerForThread(
  thread: Thread,
  mode: ComposerMode,
  account: ComposerAccountInfo,
): Promise<void> {
  const msgs = await getMessagesForThread(thread.accountId, thread.id);
  const latest = msgs[msgs.length - 1];
  if (!latest) return;
  const body = await getMessageBody(thread.accountId, latest.id);
  const message = mapMessageToMailMessage(latest, body?.bodyHtml ?? null);
  await openModeComposer(message, account, mode);
}
