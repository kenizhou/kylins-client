// Convert a `DraftInput` (the composer store's editable shape) into the
// `SendDraft` struct the Rust backend consumes over IPC.
//
// The conversion does three things worth highlighting:
//
// 1. **Prepares the HTML body** — inlines `<style>` blocks via `juice` for
//    email-client fidelity, then unwraps any baked-in `<signature>` tag so
//    recipients see the signature content without the non-standard wrapper
//    element. (Identical to the historical send path.)
//
// 2. **Extracts inline `data:` URLs** — base64 images embedded directly in
//    the body are pulled out, written to disk under the draft's outbox, and
//    referenced by `cid:` so the body's HTML can reference them. The backend
//    builds a `multipart/related` structure around them. Without this, the
//    base64 would either bloat the IPC payload or get silently stripped by
//    recipients' sanitizers. See `extractInlineImages` in `emailBuilder.ts`.
//
// 3. **Regular attachments pass through `filePath`** — the composer stages
//    picked files to disk at pick time (T7b); only the absolute path crosses
//    IPC into the backend MIME builder. This is the load-bearing change that
//    lets us send large attachments (200 MB+) without base64 ever living in
//    JS memory. Legacy drafts persisted before T7b may still carry base64
//    `content`; for those we backfill via `stageAttachmentBytes` at send
//    time (one-time, deprecated path).

import { stageAttachmentBytes, stageInlineImage } from './attachments';
import type { AddressSpec, AttachmentRef, SendDraft } from './types';
import type { DraftInput } from './drafts';
import type { Recipient } from '@/features/composer/contacts';
import { formatRecipients } from '@/features/composer/contacts';
import { stripSignature } from '@/features/composer/signaturePlacement';
import { inlineCss } from './juiceInline';
import { extractInlineImages, htmlToPlainText } from '@/utils/emailBuilder';

/**
 * Per-message crypto intent threaded into `buildSendDraft`. All fields
 * optional — when absent the draft defaults to plain MIME (`cryptoMethod =
 * 'none'`, `sign = false`, `encrypt = false`). The composer UI that actually
 * SETS these toggles is Plan 4b; Plan 4a only requires the fields to flow
 * through to the backend `SendDraft` so the send path can act on them.
 */
export interface SendCryptoOptions {
  cryptoMethod?: 'none' | 'smime';
  sign?: boolean;
  encrypt?: boolean;
}

/**
 * Build the IPC-ready `SendDraft` from a composer `DraftInput`.
 *
 * @param input         The editable draft (composer store shape).
 * @param draftId       Stable id used as the on-disk outbox folder name. When
 *                      the caller has a persisted draft row, pass its id; the
 *                      backend uses the same id for cleanup. Otherwise pass a
 *                      freshly-generated `newDraftId()`.
 * @param fallbackFrom  Sender address to use when `input.fromEmail` is null.
 * @param fallbackFromName  Sender display name to use when `input.fromName` is null.
 * @param crypto        Optional S/MIME intent (sign/encrypt). Defaults to
 *                      `none`/`false` — plain MIME. Meaningful only once
 *                      Plan 4a Tasks 3–6 honor `cryptoMethod === 'smime'`.
 */
export async function buildSendDraft(
  input: DraftInput,
  draftId: string,
  fallbackFrom: string,
  fallbackFromName?: string,
  crypto?: SendCryptoOptions,
): Promise<SendDraft> {
  // 1. Prepare HTML body (inline styles + strip signature wrapper).
  const preparedHtml = stripSignature(inlineCss(input.bodyHtml));

  // 2. Pull base64 data: URLs out of the HTML → cid: refs + on-disk files.
  const { html: htmlWithCids, images } = extractInlineImages(preparedHtml);
  const inlineImages: AttachmentRef[] = [];
  for (const img of images) {
    const staged = await stageInlineImage(draftId, img.cid, img.mimeType, img.base64);
    inlineImages.push({
      filePath: staged.filePath,
      filename: staged.filename,
      mimeType: staged.mimeType,
      cid: staged.cid,
    });
  }

  // 3. Regular attachments: path-based passthrough (T7b). Each attachment is
  //    already staged on disk at pick time, so we just rehydrate the
  //    AttachmentRef. Legacy persisted drafts that still carry base64
  //    `content` (pre-T7b) are backfilled here as a one-time migration:
  //    decode + stageAttachmentBytes. The composer never emits `content`
  //    anymore, so this branch only fires for old rows.
  const attachments: AttachmentRef[] = [];
  for (const a of input.attachments ?? []) {
    if (a.filePath) {
      attachments.push({ filePath: a.filePath, filename: a.filename, mimeType: a.mimeType });
    } else if (a.content) {
      // Legacy backfill: pre-T7b draft row with no filePath.
      const staged = await stageAttachmentBytes(
        draftId,
        a.filename,
        a.mimeType,
        base64Decode(a.content),
      );
      attachments.push({
        filePath: staged.filePath,
        filename: staged.filename,
        mimeType: staged.mimeType,
      });
    }
    // Attachments with neither filePath nor content are silently dropped;
    // they cannot be sent and would only occur for a malformed row.
  }

  // 4. Build the extra-headers list (importance / read-receipt / prevent-copy
  //    + any caller-supplied passthrough headers). Backend stores this as
  //    `Vec<(String, String)>` → the JSON we emit is `[[name, value], ...]`.
  const extraHeaders = buildExtraHeaders(input, fallbackFrom);

  // 5. Assemble the SendDraft. Optional/empty fields stay `undefined` so they
  //    are omitted from the JSON payload (Rust `skip_serializing_if`).
  const fromEmail = input.fromEmail ?? fallbackFrom;
  const fromName = input.fromName ?? fallbackFromName ?? '';
  const draft: SendDraft = {
    draftId,
    from: toAddress({ name: fromName, email: fromEmail }),
    to: input.to.map(toAddress),
    subject: input.subject,
    htmlBody: htmlWithCids,
    textBody: htmlToPlainText(htmlWithCids),
    cryptoMethod: crypto?.cryptoMethod ?? 'none',
    sign: crypto?.sign ?? false,
    encrypt: crypto?.encrypt ?? false,
  };
  if (input.cc && input.cc.length > 0) draft.cc = input.cc.map(toAddress);
  if (input.bcc && input.bcc.length > 0) draft.bcc = input.bcc.map(toAddress);
  if (input.replyTo && input.replyTo.length > 0) {
    draft.replyTo = input.replyTo.map(toAddress);
  }
  if (input.inReplyToMessageId) draft.inReplyTo = input.inReplyToMessageId;
  if (attachments.length > 0) draft.attachments = attachments;
  if (inlineImages.length > 0) draft.inlineImages = inlineImages;
  if (extraHeaders.length > 0) draft.extraHeaders = extraHeaders;
  return draft;
}

/**
 * Map a composer `Recipient` to the IPC `AddressSpec` shape. Drops the `name`
 * when it equals (or is empty for) the email so the JSON omits the field
 * entirely — matching how the historical code routed recipient formatting.
 */
function toAddress(r: Recipient): AddressSpec {
  const name = r.name?.trim();
  const email = r.email.trim();
  if (!name || name === email) return { email };
  return { name, email };
}

/**
 * Build the `extraHeaders` tuple-array from DraftInput flags + passthrough
 * headers. Importance maps to both `X-Priority` (1=high, 5=low — the values
 * Outlook/Mailspring use) and the `Importance` header; read-receipt uses
 * `Disposition-Notification-To`; prevent-copy sets the
 * `X-Classification-Prevent-Copy` flag.
 *
 * Output shape: `[[name, value], ...]` — serde's tuple-vec form.
 */
function buildExtraHeaders(input: DraftInput, fallbackFrom: string): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  // Caller-supplied passthrough headers first (preserves last-write-wins for
  // any header the flags below would also set).
  if (input.extraHeaders) {
    for (const [k, v] of Object.entries(input.extraHeaders)) headers.push([k, v]);
  }
  if (input.importance && input.importance !== 'normal') {
    headers.push(['X-Priority', input.importance === 'high' ? '1' : '5']);
    headers.push(['Importance', input.importance]);
  }
  if (input.requestReadReceipt) {
    headers.push(['Disposition-Notification-To', input.fromEmail ?? fallbackFrom]);
  }
  if (input.requestDeliveryReceipt) {
    headers.push(['Return-Receipt-To', input.fromEmail ?? fallbackFrom]);
  }
  if (input.preventCopy) {
    headers.push(['X-Classification-Prevent-Copy', 'true']);
  }
  return headers;
}

/**
 * Decode a base64 string into bytes. Carries the same fallbacks as the helper
 * in `./attachments.ts` (atob → Node Buffer) so it works in jsdom tests.
 *
 * (`extractInlineImages` returns base64 strings; this is used only for the
 * regular attachment path — `stageAttachmentBytes` writes the bytes to disk.)
 */
function base64Decode(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (globalThis as any).Buffer;
  if (B) {
    return new Uint8Array(B.from(base64, 'base64'));
  }
  throw new Error('No base64 decoder available (atob nor Buffer found)');
}

// Re-export the helpers consumers (send.ts, tests) commonly want alongside.
export { formatRecipients };
