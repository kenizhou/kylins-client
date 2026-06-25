// Smart "From" resolution for replies. Ports Mailspring's
// app/src/flux/stores/draft-factory.ts::_fromContactForReply: given the message
// the user is replying to and the account's send-as identities, pick the alias
// the message was most likely addressed to (so the reply goes out from the
// right identity). Pure: data is passed in explicitly (no AccountStore import)
// so it is unit-testable.

import type { SendAsAlias } from '@/services/db/sendAsAliases';
import { eqEmail } from './contacts';

interface ReplyableMessage {
  to: { name: string; address: string }[];
  cc?: { name: string; address: string }[];
}

/**
 * Return the alias to send the reply from. A perfect match (recipient email AND
 * name both equal a non-default alias) wins immediately; otherwise the last
 * partial match (email XOR name) is preferred; falls back to `defaultAlias`.
 */
export function resolveFromForReply(
  message: ReplyableMessage,
  aliases: SendAsAlias[],
  defaultAlias: SendAsAlias,
): SendAsAlias {
  if (aliases.length === 0) return defaultAlias;

  const defaultName = defaultAlias.displayName ?? '';
  const recipients = [...message.to, ...(message.cc ?? [])];

  let result = defaultAlias;
  for (const alias of aliases) {
    if (eqEmail(alias.email, defaultAlias.email)) continue; // default handled by fallback
    const aliasName = alias.displayName ?? '';
    for (const r of recipients) {
      const emailsMatch = eqEmail(r.address, alias.email);
      const namesMatch = aliasName.length > 0 && eqEmail(r.name, aliasName);
      const nameIsNotDefault = aliasName !== defaultName;

      if (emailsMatch && namesMatch && nameIsNotDefault) {
        return alias; // exact identity match
      }
      if (emailsMatch || (namesMatch && nameIsNotDefault)) {
        result = alias; // partial — keep scanning for an exact match
      }
    }
  }
  return result;
}
