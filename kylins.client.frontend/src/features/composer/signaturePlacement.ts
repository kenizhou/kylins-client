// Send-time signature unwrap. Inside the composer the signature is a dedicated
// TipTap block node (features/composer/SignatureNode.ts) serialized as
// `<signature id="…">…</signature>`; right before send, buildSendDraft unwraps
// the tag so recipients receive normal HTML with the visible content intact.
//
// Editor-side insert/replace/remove lives in signatureCommands.ts (ProseMirror
// transactions, not string surgery — the wrapper tag does not survive naive
// re-parsing, so regex-based replacement duplicated signatures).

/** Matches a baked-in signature block (capture group = inner HTML). */
const SIGNATURE_RE = /<signature\b[^>]*>([\s\S]*?)<\/signature>/gi;

/** Unwrap any `<signature>` blocks to their inner HTML (used on send so
 *  recipients never see the non-standard tag, but keep the visible content). */
export function stripSignature(bodyHtml: string): string {
  return bodyHtml.replace(SIGNATURE_RE, '$1').replace(/\s+$/, '');
}
