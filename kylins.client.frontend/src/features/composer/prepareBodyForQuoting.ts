// Build the quoted/forwarded original-message body for the composer. Ports
// Mailspring's draft-factory.prepareBodyForQuoting + createDraftForReply /
// createDraftForForward:
//   1. sanitize the untrusted original HTML (DOMPurify viewer policy),
//   2. inline its <style> CSS onto elements (juice) so it renders in the editor,
//   3. strip `cid:` inline images (reply) or rewrite them to data: URLs
//      (forward, when a cidMap is supplied).
// Then wrap in one of two quote styles (QuoteStyle pref):
//   - 'outlook' (default): an unindented From/Sent/To/[Cc]/Subject header
//     block followed by an <hr data-quote="original"> separator and the
//     unindented original body — the MS Outlook pattern. The hr's data-quote
//     attribute survives TipTap round-trips (see editorExtensions.ts) and is
//     the robust quote-boundary marker for signature placement.
//   - 'gmail': "On … wrote:" attribution + indented <blockquote
//     class="gmail_quote">, Gmail/Mailspring style.

import { escapeHtml } from '@/utils/sanitize';
import { inlineCss } from '@/services/composer/juiceInline';
import { sanitizeForCompose } from '@/services/composer/sanitizeForCompose';
import { formatFullDate } from '@/utils/formatDate';
import { formatRecipient, toRecipient } from './contacts';

export type QuoteStyle = 'outlook' | 'gmail';

export interface QuoteableMessage {
  html: string | null;
  text: string | null;
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  cc?: { name: string; address: string }[];
  subject: string;
  date: string;
}

function plaintextToHtml(text: string): string {
  return `<pre>${escapeHtml(text).replace(/\r?\n/g, '<br/>')}</pre>`;
}

const CID_IMG_RE = /<img\b[^>]*\ssrc=["']cid:[^"']*["'][^>]*>/gi;
const CID_SRC_RE = /src=(["'])cid:([^"']+)\1/gi;

/**
 * Sanitize + inline CSS + strip CID inline images from an original message
 * body, returning safe, self-styled HTML ready to embed in the editor.
 *
 * When `cidMap` is provided, `src="cid:..."` references that exist in the map
 * are rewritten to the corresponding `data:` URL so forwarded inline images
 * render in the composer and survive to be re-attached as CID parts at send
 * time. References not in the map are left as-is; when no map is provided the
 * entire CID image tag is stripped (reply behavior).
 */
export function prepareBodyForQuoting(
  message: QuoteableMessage,
  cidMap?: Map<string, string>,
): string {
  const html = message.html && message.html.trim() ? message.html : null;
  let source = html ?? plaintextToHtml(message.text ?? '');
  if (cidMap) {
    source = source.replace(CID_SRC_RE, (_match, _quote, cid) => {
      const dataUrl = cidMap.get(cid);
      return dataUrl ? `src="${dataUrl}"` : _match;
    });
  } else {
    source = source.replace(CID_IMG_RE, '');
  }
  source = sanitizeForCompose(source);
  source = inlineCss(source);
  return source;
}

/** The `<hr>` marker separating the user's text from the quoted original. The
 *  `data-quote` attribute is preserved by the extended HorizontalRule node
 *  (editorExtensions.ts) and detected by findQuoteInsertPos for signature
 *  placement. */
const QUOTE_SEPARATOR = '<hr data-quote="original"/>';

/** Outlook-style header block: one paragraph of bold-labelled lines (a single
 *  <p> with <br/>s — TipTap flattens divs to paragraphs anyway, and <b>
 *  survives StarterKit's Bold mark). Unindented, no blockquote. */
function outlookHeaderBlock(message: QuoteableMessage, opts: { forwarded: boolean }): string {
  const line = (label: string, value: string) =>
    `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`;
  const lines: string[] = [];
  if (opts.forwarded) {
    lines.push('---------- Forwarded message ----------');
  }
  lines.push(line('From', formatRecipient(toRecipient(message.from))));
  lines.push(line('Sent', formatFullDate(message.date)));
  lines.push(line('To', message.to.map((t) => formatRecipient(toRecipient(t))).join(', ')));
  if (message.cc && message.cc.length > 0) {
    lines.push(line('Cc', message.cc.map((t) => formatRecipient(toRecipient(t))).join(', ')));
  }
  lines.push(line('Subject', message.subject));
  return `<p>${lines.join('<br/>')}</p>`;
}

/** Reply quote. 'outlook' (default): unindented header block + separator +
 *  original body. 'gmail': "On … wrote:" + indented blockquote. */
export function buildReplyQuote(message: QuoteableMessage, style: QuoteStyle = 'outlook'): string {
  const prepared = prepareBodyForQuoting(message);
  if (style === 'gmail') {
    const attribution = `On ${escapeHtml(formatFullDate(message.date))}, ${escapeHtml(
      formatRecipient(toRecipient(message.from)),
    )} wrote:`;
    return (
      '<br/><br/>' +
      `<div class="gmail_quote_attribution">${attribution}</div>` +
      '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex;">' +
      prepared +
      '<br/></blockquote>'
    );
  }
  return (
    '<br/><br/>' + outlookHeaderBlock(message, { forwarded: false }) + QUOTE_SEPARATOR + prepared
  );
}

/** Forward quote. 'outlook' (default): "Forwarded message" header block +
 *  separator + unindented body. 'gmail': same content wrapped in an indented
 *  gmail_quote blockquote (a single ProseMirror blockquote node, like the
 *  gmail reply quote, so the signature block can be placed above it). */
export function buildForwardQuote(
  message: QuoteableMessage,
  cidMap?: Map<string, string>,
  style: QuoteStyle = 'outlook',
): string {
  const prepared = prepareBodyForQuoting(message, cidMap);
  if (style === 'gmail') {
    const header = (label: string, value: string) =>
      `${escapeHtml(label)}: ${escapeHtml(value)}<br/>`;
    const lines: string[] = [];
    lines.push('<br/>');
    lines.push(
      '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex;">',
    );
    lines.push('<br/>---------- Forwarded Message ---------<br/><br/>');
    lines.push(header('From', formatRecipient(toRecipient(message.from))));
    lines.push(header('Subject', message.subject));
    lines.push(header('Date', formatFullDate(message.date)));
    lines.push(header('To', message.to.map((t) => formatRecipient(toRecipient(t))).join(', ')));
    if (message.cc && message.cc.length > 0) {
      lines.push(header('Cc', message.cc.map((t) => formatRecipient(toRecipient(t))).join(', ')));
    }
    lines.push('<br/>');
    lines.push(prepared);
    lines.push('<br/>');
    lines.push('</blockquote>');
    return lines.join('');
  }
  return (
    '<br/><br/>' + outlookHeaderBlock(message, { forwarded: true }) + QUOTE_SEPARATOR + prepared
  );
}
