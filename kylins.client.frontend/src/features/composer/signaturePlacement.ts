// Signature placement above the quoted original (Mailspring-faithful). The
// signature is baked into the editor body as a `<signature id="…">…</signature>`
// block sitting just ABOVE the `.gmail_quote` reply/forward region, so it is
// WYSIWYG and survives copy/paste.
//
// Reference anchors (Mailspring):
//   RegExpUtils.nativeQuoteStartRegex()  -> /<\w+[^>]*gmail_quote/i
//   RegExpUtils.mailspringSignatureRegex() -> /<signature id="…">…<\/signature>/

/** Matches the start of a Gmail-style quoted region (blockquote or div). */
export const NATIVE_QUOTE_START_RE = /<\w+[^>]*gmail_quote/i;

/** Matches a baked-in signature block (capture group = inner HTML). */
const SIGNATURE_RE = /<signature\b[^>]*>([\s\S]*?)<\/signature>/gi;

/** Unwrap any `<signature>` blocks to their inner HTML (used on send so
 *  recipients never see the non-standard tag, but keep the visible content). */
export function stripSignature(bodyHtml: string): string {
  return bodyHtml.replace(SIGNATURE_RE, '$1').replace(/\s+$/, '');
}

/** Remove any `<signature>` blocks entirely (tag + content). */
export function removeSignature(bodyHtml: string): string {
  return bodyHtml.replace(SIGNATURE_RE, '').trim();
}

/**
 * Insert (or replace) the signature so it sits just above the `gmail_quote`
 * block, or at the end of the body when there is no quote. Any existing
 * signature is removed first. Pass `null` to strip the signature entirely.
 */
export function applySignatureAboveQuote(
  bodyHtml: string,
  signature: { id: string; html: string } | null,
): string {
  const body = removeSignature(bodyHtml);
  if (!signature) return body;

  const sigBlock = `<signature id="${signature.id}">${signature.html}</signature>`;
  const match = body.match(NATIVE_QUOTE_START_RE);
  if (match && match.index !== undefined) {
    return body.slice(0, match.index) + sigBlock + body.slice(match.index);
  }
  return body + sigBlock;
}
