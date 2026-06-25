// Build the quoted/forwarded original-message body for the composer. Ports
// Mailspring's draft-factory.prepareBodyForQuoting + createDraftForReply /
// createDraftForForward:
//   1. sanitize the untrusted original HTML (DOMPurify viewer policy),
//   2. inline its <style> CSS onto elements (juice) so it renders in the editor,
//   3. strip `cid:` inline images (forwarded mail re-attaches them as files in
//      a later phase, once MailMessage carries attachments).
// Then wrap as a gmail_quote reply blockquote ("On … wrote:") or a
// "Forwarded Message" header block.

import { escapeHtml } from '@/utils/sanitize';
import { inlineCss } from '@/services/composer/juiceInline';
import { sanitizeForCompose } from '@/services/composer/sanitizeForCompose';
import { formatFullDate } from '@/utils/formatDate';
import { formatRecipient, toRecipient } from './contacts';

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

/**
 * Sanitize + inline CSS + strip CID inline images from an original message
 * body, returning safe, self-styled HTML ready to embed in the editor.
 */
export function prepareBodyForQuoting(message: QuoteableMessage): string {
  const html = message.html && message.html.trim() ? message.html : null;
  let source = html ?? plaintextToHtml(message.text ?? '');
  source = source.replace(CID_IMG_RE, '');
  source = sanitizeForCompose(source);
  source = inlineCss(source);
  return source;
}

/** Reply quote: attribution line + `<blockquote class="gmail_quote">`. */
export function buildReplyQuote(message: QuoteableMessage): string {
  const prepared = prepareBodyForQuoting(message);
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

/** Forward quote: "Forwarded Message" header block + body, wrapped in gmail_quote. */
export function buildForwardQuote(message: QuoteableMessage): string {
  const prepared = prepareBodyForQuoting(message);
  const header = (label: string, value: string) =>
    `${escapeHtml(label)}: ${escapeHtml(value)}<br/>`;

  const lines: string[] = [];
  lines.push('<br/>');
  lines.push('<div class="gmail_quote">');
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
  lines.push('</div>');
  return lines.join('');
}
