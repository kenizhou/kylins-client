// Recipient parsing & formatting for the composer. Ports Mailspring's
// contact-store.parseContactsInString / contact.isValid logic as plain,
// store-coupling-free functions so they are unit-testable.
//
// Mailspring reference: app/src/flux/stores/contact-store.ts (parseContactsInString)
// and app/src/flux/models/contact.ts (isValid). Adapted: synchronous (no contact
// name-lookup DB call — the UI handles that via autocomplete), and improved to
// keep names intact when they contain commas inside quotes.

/** A structured recipient. `name` falls back to `email` when no display name. */
export interface Recipient {
  name: string;
  email: string;
}

/**
 * Email token regex — a pragmatic RFC-5321 subset matching the addresses
 * Mailspring/Gmail treat as valid. Kept as a source string so we can build both
 * a global (find-all) and an anchored (full-match) instance from it.
 */
const EMAIL_SOURCE = '[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}';
const EMAIL_ANCHORED = new RegExp(`^${EMAIL_SOURCE}$`);

/** True only when the whole string is a valid email address (mirrors Contact.isValid). */
export function isValidEmail(email: string): boolean {
  return EMAIL_ANCHORED.test(email.trim());
}

function isQuote(ch: string | undefined): boolean {
  return ch === '"' || ch === "'";
}

/** Remove matching surrounding quotes and/or angle brackets from a bare token. */
export function normalizeEmail(token: string): string {
  let t = token.trim();
  if (t.length >= 2 && isQuote(t[0]) && isQuote(t[t.length - 1])) t = t.slice(1, -1);
  if (t.length >= 2 && t[0] === '<' && t[t.length - 1] === '>') t = t.slice(1, -1);
  return t.trim();
}

/** Strip one layer of matching surrounding quotes from a display name. */
function unquote(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && isQuote(trimmed[0]) && isQuote(trimmed[trimmed.length - 1])) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Build a Recipient from a name+address pair (e.g. a message participant). */
export function toRecipient(p: { name: string; address: string }): Recipient {
  return { name: p.name || p.address, email: p.address };
}

/**
 * Parse a single recipient token into a Recipient. Handles `Name <email>`,
 * `"Name" <email>`, `Name (email)`, and bare `email`. Returns null for empty
 * input. For unparseable text, returns a Recipient whose email is the raw text
 * (so the UI can render it as an invalid chip — check `isValidEmail`).
 */
export function parseRecipient(raw: string): Recipient | null {
  const input = raw.trim();
  if (!input) return null;

  // "Name" <email>  |  Name <email>  (dotall so newlines in the name are OK)
  const angle = input.match(/^(.*?)\s*<([^>]*)>\s*$/s);
  if (angle) {
    const [, nameRaw = '', emailRaw = ''] = angle;
    const email = emailRaw.trim();
    if (isValidEmail(email)) return { name: unquote(nameRaw) || email, email };
  }

  // Name (email)
  const paren = input.match(/^(.*?)\s*\(([^)]*)\)\s*$/s);
  if (paren) {
    const [, nameRaw = '', emailRaw = ''] = paren;
    const email = emailRaw.trim();
    if (isValidEmail(email)) return { name: unquote(nameRaw) || email, email };
  }

  // Bare email, possibly quoted or bracketed.
  const cleaned = normalizeEmail(input);
  if (isValidEmail(cleaned)) return { name: cleaned, email: cleaned };

  // Fall back: keep what the user typed so the chip can render (and be flagged
  // invalid via isValidEmail).
  return { name: cleaned, email: cleaned };
}

/**
 * Parse a free-form string that may contain multiple recipients (comma/
 * semicolon/newline separated, possibly with quoted names containing commas)
 * into a Recipient[]. Walks an email regex across the whole string and recovers
 * each name from the text before its enclosing `<…>` / `(…)`, so commas inside
 * quoted names do not split incorrectly.
 */
export function parseRecipients(raw: string): Recipient[] {
  const detected: Recipient[] = [];
  if (!raw || !raw.trim()) return detected;

  const re = new RegExp(EMAIL_SOURCE, 'gi');
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const matchIndex = match.index;
    const email = match[0];
    if (!email) continue;

    const charBefore = raw[matchIndex - 1];
    const charAfter = raw[matchIndex + email.length];

    let name = '';
    if ((charBefore === '<' && charAfter === '>') || (charBefore === '(' && charAfter === ')')) {
      // Name is the text between the previous recipient and this opening bracket,
      // with leading separators (comma/semicolon/whitespace) trimmed.
      name = raw
        .slice(lastEnd, matchIndex - 1)
        .replace(/^[,;\s]+/, '')
        .trim();
    }

    lastEnd = matchIndex + email.length;
    if (charAfter === '>' || charAfter === ')') lastEnd += 1;

    detected.push({ name: unquote(name) || email, email });
  }

  if (detected.length === 0) {
    // No recognizable email — keep the whole blob as one (invalid) recipient so
    // the chip can surface the validation error rather than silently dropping it.
    const cleaned = normalizeEmail(raw.trim());
    return [{ name: cleaned, email: cleaned }];
  }
  return detected;
}

/** Format a Recipient as an RFC address: `Name <email>` (or just `email`). */
export function formatRecipient(r: Recipient): string {
  const email = r.email.trim();
  const name = r.name.trim();
  if (!name || name === email) return email;
  // Quote the name if it contains characters that would break address parsing.
  if (/[,<>"]/.test(name)) {
    return `"${name.replace(/"/g, '\\"')}" <${email}>`;
  }
  return `${name} <${email}>`;
}

/** Format a list of Recipients as a list of RFC address strings. */
export function formatRecipients(rs: Recipient[]): string[] {
  return rs.map(formatRecipient);
}
