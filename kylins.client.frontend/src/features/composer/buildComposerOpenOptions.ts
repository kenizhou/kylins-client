// Centralized seeding helper for the modal composer in reply / reply-all /
// forward modes. Ports the logic already proven in InlineReply.tsx so every
// entry point (ribbon, message list, reading pane, pop-out) produces the same
// recipients, subject, quoted body, smart-From, and attachment flags.

import type { MailMessage } from '@/features/view/viewStore';
import type { ComposeWindowOptions } from '@/utils/composeWindow';
import type { SendAsAlias } from '@/services/db/sendAsAliases';
import { getAliasesForAccount, mapDbAlias, accountAsAlias } from '@/services/db/sendAsAliases';
import { fetchInlineImages } from '@/services/db/attachments';
import { buildReplyQuote, buildForwardQuote } from './prepareBodyForQuoting';
import { participantsForReply, participantsForReplyAll } from './recipientsForReply';
import { resolveFromForReply } from './fromResolution';
import { subjectWithPrefix } from './subjectPrefix';

export type ComposerOpenMode = 'reply' | 'replyAll' | 'forward';

export interface ComposerAccountInfo {
  id: string;
  email: string;
  displayName?: string;
}

export interface BuildComposerOpenOptionsInput {
  account: ComposerAccountInfo;
  message: MailMessage;
  mode: ComposerOpenMode;
  /** For the "reply with attachments" ribbon variant. */
  includeOriginalAttachments?: boolean;
  /** Forward the original as a .eml attachment (no inline quote). */
  forwardAsAttachment?: boolean;
}

function dedupAliases(aliases: SendAsAlias[]): SendAsAlias[] {
  const seen = new Set<string>();
  return aliases.filter((a) => {
    const key = a.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  const dbAliases = (await getAliasesForAccount(account.id)).map(mapDbAlias);
  const merged = dedupAliases([accountAsAlias(account), ...dbAliases]);
  const selfEmails = merged.map((a) => a.email);

  const defaultAlias = merged.find((a) => a.isDefault) ?? merged[0];
  const fromEmail =
    merged.length <= 1 || !defaultAlias
      ? (defaultAlias?.email ?? account.email)
      : resolveFromForReply(message, merged, defaultAlias).email;

  let to: ComposeWindowOptions['to'];
  let cc: ComposeWindowOptions['cc'];
  if (isForward) {
    to = [];
    cc = undefined;
  } else if (mode === 'replyAll') {
    const all = participantsForReplyAll(message, selfEmails);
    to = all.to;
    cc = all.cc;
  } else {
    to = participantsForReply(message, selfEmails).to;
    cc = undefined;
  }

  const subject = subjectWithPrefix(message.subject, isForward ? 'Fwd:' : 'Re:');

  let bodyHtml: string;
  let cidMap: Map<string, string> | undefined;
  if (input.forwardAsAttachment) {
    bodyHtml = '';
  } else if (isForward) {
    const inlineParts = await fetchInlineImages(account.id, message.id);
    if (inlineParts.length > 0) {
      cidMap = new Map(
        inlineParts.map((p) => [p.contentId, `data:${p.mimeType};base64,${p.base64}`]),
      );
    }
    bodyHtml = buildForwardQuote(message, cidMap);
  } else {
    bodyHtml = buildReplyQuote(message);
  }

  const originalMessageId =
    isForward || input.includeOriginalAttachments ? (message.messageId ?? null) : null;

  return {
    mode,
    to,
    cc,
    bcc: [],
    replyTo: [],
    subject,
    bodyHtml,
    fromEmail,
    accountId: account.id,
    threadId: message.threadId ?? message.id,
    inReplyToMessageId: isForward ? null : (message.messageId ?? null),
    classificationId: message.classificationId ?? undefined,
    isEncrypted: message.isEncrypted,
    isSigned: message.isSigned,
    originalMessageId,
    includeOriginalAttachments: input.forwardAsAttachment
      ? false
      : !!(isForward || input.includeOriginalAttachments),
    forwardAsAttachment: input.forwardAsAttachment,
    originalMessageSubject: input.forwardAsAttachment ? message.subject : undefined,
    originalMessageHtml: input.forwardAsAttachment ? message.html : undefined,
    originalMessageText: input.forwardAsAttachment ? message.text : undefined,
  };
}
