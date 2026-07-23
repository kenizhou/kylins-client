// Centralized seeding helper for the modal composer in reply / reply-all /
// forward modes. Thin adapter over draftFactory.buildDraftSeed (the single
// seeding implementation shared with the inline composer) — every entry point
// (ribbon, message list, reading pane, pop-out) produces the same recipients,
// subject, quoted body, smart-From, and attachment flags.

import type { MailMessage } from '@/features/view/viewStore';
import type { ComposeWindowOptions } from '@/utils/composeWindow';
import { buildDraftSeed, type DraftSeedAccount, type InlineIntent } from './draftFactory';

export type ComposerOpenMode = 'reply' | 'replyAll' | 'forward';

export type ComposerAccountInfo = DraftSeedAccount;

export interface BuildComposerOpenOptionsInput {
  account: ComposerAccountInfo;
  message: MailMessage;
  mode: ComposerOpenMode;
  /** For the "reply with attachments" ribbon variant. */
  includeOriginalAttachments?: boolean;
  /** Forward the original as a .eml attachment (no inline quote). */
  forwardAsAttachment?: boolean;
}

/**
 * Build the complete payload needed to open the modal composer for a reply,
 * reply-all, or forward. The result carries enough context that the modal
 * composer can render the full body, seed attachments, and place the signature
 * above the quoted original.
 */
export async function buildComposerOpenOptions(
  input: BuildComposerOpenOptionsInput,
): Promise<ComposeWindowOptions> {
  const { account, message, mode } = input;
  const isForward = mode === 'forward';

  const intent: InlineIntent = input.includeOriginalAttachments
    ? mode === 'replyAll'
      ? 'replyAllWithAttachments'
      : mode === 'reply'
        ? 'replyWithAttachments'
        : 'forward'
    : mode;
  const seed = await buildDraftSeed({
    account,
    message,
    intent,
    // Forward-as-attachment carries no inline quote — the original goes along
    // as a synthesized .eml instead, so skip the body (and its inline-image
    // fetch) entirely.
    skipBody: input.forwardAsAttachment,
  });

  const originalMessageId =
    isForward || input.includeOriginalAttachments ? (message.messageId ?? null) : null;

  return {
    mode,
    to: seed.to,
    cc: seed.cc.length > 0 ? seed.cc : undefined,
    bcc: [],
    replyTo: [],
    subject: seed.subject,
    bodyHtml: seed.bodyHtml,
    fromEmail: seed.fromEmail,
    accountId: account.id,
    threadId: seed.threadId,
    inReplyToMessageId: seed.inReplyToMessageId,
    classificationId: message.classificationId ?? undefined,
    isEncrypted: message.isEncrypted,
    isSigned: message.isSigned,
    originalMessageId,
    includeOriginalAttachments: input.forwardAsAttachment ? false : seed.includeOriginalAttachments,
    forwardAsAttachment: input.forwardAsAttachment,
    originalMessageSubject: input.forwardAsAttachment ? message.subject : undefined,
    originalMessageHtml: input.forwardAsAttachment ? message.html : undefined,
    originalMessageText: input.forwardAsAttachment ? message.text : undefined,
  };
}
