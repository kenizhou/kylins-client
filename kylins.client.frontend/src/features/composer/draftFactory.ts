// DraftFactory — the single place that turns (account, message, intent) into a
// fully-resolved composer seed. Ports Mailspring's draft-factory role: UI
// surfaces (inline dock, OS compose window) never build reply bodies or
// recipient lists themselves; they fire an intent and consume a DraftSeed.
//
// Every async step happens BEFORE any editor exists: send-as alias merge
// (→ complete selfEmails for reply-all exclusion), smart-From resolution,
// recipients, subject, and — for forwards — the inline-image CID map baked
// into bodyHtml. This eliminates two historical bug classes:
//   - reply-all Cc'ing the user's own aliases (the inline path used to compute
//     recipients with only the account address before aliases finished loading)
//   - the forward inline-image effect calling editor.setContent after mount,
//     wiping text the user had already typed
//
// Pure apart from its injected/imported data sources (alias DB, attachment
// fetches, preferences store for the quote style default) — unit-testable
// with those mocked.

import type { MailMessage } from '@/features/view/viewStore';
import type { Recipient } from './contacts';
import { buildReplyQuote, buildForwardQuote, type QuoteStyle } from './prepareBodyForQuoting';
import { participantsForReply, participantsForReplyAll } from './recipientsForReply';
import { resolveFromForReply } from './fromResolution';
import { subjectWithPrefix } from './subjectPrefix';
import {
  getAliasesForAccount,
  mapDbAlias,
  accountAsAlias,
  type SendAsAlias,
} from '@/services/db/sendAsAliases';
import {
  getAttachments,
  fetchAttachment,
  fetchInlineImages,
  cachedImageToDataUrl,
} from '@/services/db/attachments';
import { stageAttachment, newAttachmentId } from '@/services/composer/attachments';
import { usePreferencesStore } from '@/stores/preferencesStore';
import type { ComposerAttachment } from '@/stores/composerStore';

/** What the user asked to do. The with-attachment variants are replies that
 *  also re-attach the original message's files (Outlook's "Reply with
 *  Attachment" pattern). */
export type InlineIntent =
  | 'reply'
  | 'replyAll'
  | 'replyWithAttachments'
  | 'replyAllWithAttachments'
  | 'forward';

/** The recipient/subject family an intent belongs to (drives recipients,
 *  subject prefix, threading headers, signature mode). */
export type IntentFamily = 'reply' | 'replyAll' | 'forward';

export function intentFamily(intent: InlineIntent): IntentFamily {
  switch (intent) {
    case 'reply':
    case 'replyWithAttachments':
      return 'reply';
    case 'replyAll':
    case 'replyAllWithAttachments':
      return 'replyAll';
    case 'forward':
      return 'forward';
  }
}

/** True when the intent re-attaches the original message's files. */
export function intentIncludesAttachments(intent: InlineIntent): boolean {
  return intent === 'replyWithAttachments' || intent === 'replyAllWithAttachments';
}

export interface DraftSeedAccount {
  id: string;
  email: string;
  displayName?: string | null;
}

/** Everything a composer surface needs to open, fully resolved. */
export interface DraftSeed {
  to: Recipient[];
  cc: Recipient[];
  subject: string;
  bodyHtml: string;
  fromEmail: string;
  /** All of the user's own addresses (account + aliases) — for reply-all
   *  exclusion and for later reply↔replyAll switching. */
  selfEmails: string[];
  threadId: string | null;
  /** null for forwards (a forward starts a new branch, no In-Reply-To). */
  inReplyToMessageId: string | null;
  includeOriginalAttachments: boolean;
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

export interface BuildDraftSeedInput {
  account: DraftSeedAccount;
  message: MailMessage;
  intent: InlineIntent;
  /** Defaults to the user's Quote Style preference. */
  quoteStyle?: QuoteStyle;
  /** Skip body construction entirely (forward-as-attachment carries no inline
   *  quote — avoids the full-message inline-image fetch). bodyHtml = ''. */
  skipBody?: boolean;
}

/**
 * Resolve the complete composer seed for an intent. Awaits alias loading and
 * (for forwards) inline-image fetching, so the returned bodyHtml is final —
 * no post-mount editor rebuild is ever needed.
 */
export async function buildDraftSeed(input: BuildDraftSeedInput): Promise<DraftSeed> {
  const { account, message, intent } = input;
  const quoteStyle =
    input.quoteStyle ??
    (usePreferencesStore.getState().quoteStyle === 'gmail' ? 'gmail' : 'outlook');
  const family = intentFamily(intent);

  const dbAliases = (await getAliasesForAccount(account.id)).map(mapDbAlias);
  const merged = dedupAliases([
    accountAsAlias({
      id: account.id,
      email: account.email,
      displayName: account.displayName ?? undefined,
    }),
    ...dbAliases,
  ]);
  const selfEmails = merged.map((a) => a.email);

  const defaultAlias = merged.find((a) => a.isDefault) ?? merged[0];
  const fromEmail =
    merged.length <= 1 || !defaultAlias
      ? (defaultAlias?.email ?? account.email)
      : resolveFromForReply(message, merged, defaultAlias).email;

  let to: Recipient[] = [];
  let cc: Recipient[] = [];
  if (family === 'replyAll') {
    const all = participantsForReplyAll(message, selfEmails);
    to = all.to;
    cc = all.cc;
  } else if (family === 'reply') {
    to = participantsForReply(message, selfEmails).to;
  }

  const subject = subjectWithPrefix(message.subject, family === 'forward' ? 'Fwd:' : 'Re:');

  let bodyHtml: string;
  if (input.skipBody) {
    bodyHtml = '';
  } else if (family === 'forward') {
    // Bake the CID → data: map into the body now. The send pipeline's
    // `extractInlineImages` matches data: URLs to re-attach inline images as
    // CID parts, so cached files are read as data URLs (not convertFileSrc).
    //
    // Gate the fetch on the body actually referencing cid: images —
    // fetchInlineImages does a full-message IMAP fetch (BODY.PEEK[]) just to
    // enumerate parts, which made EVERY forward (even plain-text ones) stall
    // for seconds. Same gate the ReadingPane uses before resolving inline
    // images for display.
    const hasCidRefs = /\bcid:/i.test(message.html ?? '');
    const inlineParts = hasCidRefs ? ((await fetchInlineImages(account.id, message.id)) ?? []) : [];
    let cidMap: Map<string, string> | undefined;
    if (inlineParts.length > 0) {
      cidMap = new Map<string, string>();
      for (const p of inlineParts) {
        cidMap.set(p.contentId, await cachedImageToDataUrl(p.filePath, p.mimeType));
      }
    }
    bodyHtml = buildForwardQuote(message, cidMap, quoteStyle);
  } else {
    bodyHtml = buildReplyQuote(message, quoteStyle);
  }

  return {
    to,
    cc,
    subject,
    bodyHtml,
    fromEmail,
    selfEmails,
    threadId: message.threadId ?? message.id,
    inReplyToMessageId: family === 'forward' ? null : (message.messageId ?? null),
    includeOriginalAttachments: family === 'forward' || intentIncludesAttachments(intent),
  };
}

/**
 * Fetch the original message's attachments and stage them into a draft's
 * outbox, returning file-backed ComposerAttachments tagged `origin: 'seeded'`
 * (so the UI can distinguish them from user-picked files). Used for forwards
 * and the reply-with-attachment intents. Inline images are intentionally
 * re-attached as regular files rather than preserved as CID references,
 * matching the windowed composer's forward path.
 *
 * `shouldAbort` is checked between every async step: when it returns true
 * (session discarded/replaced mid-flight), staging stops immediately so no
 * files are written into an outbox dir that was already cleaned up.
 */
export async function seedOriginalAttachments(
  accountId: string,
  messageId: string,
  stagingDraftId: string,
  shouldAbort?: () => boolean,
): Promise<ComposerAttachment[]> {
  const rows = await getAttachments(accountId, messageId);
  const seeded: ComposerAttachment[] = [];
  for (const row of rows) {
    if (shouldAbort?.()) return [];
    const partId = row.imapPartId || row.id;
    // sync_fetch_attachment returns a cached file path (no base64 over IPC).
    // Copy the cached file into the draft outbox.
    const fetched = await fetchAttachment(accountId, messageId, partId);
    if (shouldAbort?.()) return [];
    const destPath = await stageAttachment(
      stagingDraftId,
      fetched.filePath,
      row.filename || 'attachment',
    );
    seeded.push({
      id: newAttachmentId(),
      filename: row.filename || 'attachment',
      mimeType: fetched.mimeType || row.mimeType || 'application/octet-stream',
      size: row.size,
      filePath: destPath,
      origin: 'seeded',
    });
  }
  return seeded;
}
