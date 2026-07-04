// Send-flow helpers retained after T7.
//
// Previously this module built the entire RFC5322 MIME message + base64url
// envelope in TS (`buildRawEmail`). MIME assembly has moved to the Rust
// backend (`mail_builder::MessageBuilder` — see
// `kylins.client.backend/src/mail/builder.rs`); only the two body-prep
// helpers that the TS side still needs remain here:
//
// - `htmlToPlainText` — used by `buildSendDraft` to populate `textBody`
//   (the multipart/alternative plain part).
// - `extractInlineImages` — used by `buildSendDraft` to pull `data:` URLs
//   out of the body so they can be staged on disk and referenced by `cid:`
//   (no base64 crosses IPC). The two consumers are `buildSendDraft` and the
//   message viewer (which uses it to canonicalize incoming HTML).

/** Inline-image extraction result element. `base64` is the raw payload. */
export interface InlineImage {
  cid: string;
  mimeType: string;
  base64: string;
}

/**
 * Convert HTML to a plain-text approximation suitable for the
 * multipart/alternative text part. Strips tags but preserves paragraph and
 * line breaks; un-escapes the common entities.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Extract base64 `data:` URLs from `<img>` tags and replace each with a
 * `cid:` reference. Returns the rewritten HTML plus the extracted image
 * payloads (caller writes them to disk and emits `AttachmentRef`s with the
 * matching `cid`).
 *
 * The generated `cid` is opaque but shaped like an email
 * (`inline_<timestamp>_<index>@kylins.mail`) so it round-trips cleanly
 * through mail-builder's `MessageId` header writer.
 */
export function extractInlineImages(html: string): { html: string; images: InlineImage[] } {
  const images: InlineImage[] = [];
  const processed = html.replace(
    /<img([^>]*)\ssrc="data:([^;]+);base64,([^"]+)"([^>]*)>/g,
    (_match, before: string, mime: string, data: string, after: string) => {
      const cid = `inline_${Date.now()}_${images.length}@kylins.mail`;
      images.push({ cid, mimeType: mime, base64: data });
      return `<img${before} src="cid:${cid}"${after}>`;
    },
  );
  return { html: processed, images };
}
