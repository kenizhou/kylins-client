// Reply / Reply-All participant resolution. Ports Mailspring's
// app/src/flux/models/message.ts::participantsForReply / participantsForReplyAll:
// decides who a reply (or reply-all) goes To and Cc, honoring Reply-To,
// self-sent messages, dedup, and excluding the user's own addresses.
//
// Pure: takes the message + the user's own email addresses (account address and
// any aliases) explicitly so it is unit-testable.

import type { Recipient } from './contacts';
import { toRecipient, eqEmail } from './contacts';

interface SourceMessage {
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  cc?: { name: string; address: string }[];
  replyTo?: { name: string; address: string }[];
}

function isSelf(address: string, selfEmails: string[]): boolean {
  return selfEmails.some((s) => eqEmail(s, address));
}

function dedupeByEmail(rs: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of rs) {
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Participants for a single reply: To = Reply-To (if present & not self) else sender. */
export function participantsForReply(
  message: SourceMessage,
  selfEmails: string[],
): { to: Recipient[] } {
  const replyTo0 = message.replyTo?.[0];
  const to =
    message.replyTo &&
    message.replyTo.length > 0 &&
    replyTo0 &&
    !isSelf(replyTo0.address, selfEmails)
      ? message.replyTo.map(toRecipient)
      : [toRecipient(message.from)];
  return { to: dedupeByEmail(to) };
}

/**
 * Participants for Reply-All:
 *  - If the message was sent BY me, To = original To, Cc = original Cc (minus self).
 *  - Else if Reply-To is present & not self, To = Reply-To, Cc = To+Cc (minus self & sender).
 *  - Else To = sender, Cc = To+Cc (minus self & sender).
 */
export function participantsForReplyAll(
  message: SourceMessage,
  selfEmails: string[],
): { to: Recipient[]; cc: Recipient[] } {
  const others = [...message.to, ...(message.cc ?? [])];
  const excludeSelf = (list: { name: string; address: string }[]) =>
    list.filter((p) => !isSelf(p.address, selfEmails));

  let to: Recipient[];
  let cc: Recipient[];

  if (isSelf(message.from.address, selfEmails)) {
    // I sent it — reply-all goes back to the original recipients.
    to = dedupeByEmail(excludeSelf(message.to).map(toRecipient));
    cc = dedupeByEmail(excludeSelf(message.cc ?? []).map(toRecipient));
  } else {
    const replyTo0 = message.replyTo?.[0];
    const fromAddrs = [message.from.address];
    const excludeSelfAndSender = (list: { name: string; address: string }[]) =>
      excludeSelf(list).filter((p) => !fromAddrs.some((a) => eqEmail(a, p.address)));

    if (
      message.replyTo &&
      message.replyTo.length > 0 &&
      replyTo0 &&
      !isSelf(replyTo0.address, selfEmails)
    ) {
      to = dedupeByEmail(message.replyTo.map(toRecipient));
    } else {
      to = dedupeByEmail([toRecipient(message.from)]);
    }
    cc = dedupeByEmail(excludeSelfAndSender(others).map(toRecipient));
  }

  return { to, cc };
}
