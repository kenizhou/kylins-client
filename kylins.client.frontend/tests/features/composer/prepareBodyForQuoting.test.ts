import { describe, it, expect } from 'vitest';
import {
  prepareBodyForQuoting,
  buildReplyQuote,
  buildForwardQuote,
  type QuoteableMessage,
} from '@/features/composer/prepareBodyForQuoting';

const baseMsg: QuoteableMessage = {
  html: '<p>Hello <script>alert(1)</script>world</p>',
  text: null,
  from: { name: 'Kevin', address: 'kevin@x.com' },
  to: [{ name: 'Me', address: 'me@x.com' }],
  subject: 'Hi there',
  date: '2026-06-24T09:30:00Z',
};

describe('prepareBodyForQuoting', () => {
  it('strips scripts from the original HTML', () => {
    const out = prepareBodyForQuoting(baseMsg);
    expect(out).not.toContain('<script');
    expect(out).toContain('world');
  });

  it('strips cid: inline images', () => {
    const out = prepareBodyForQuoting({
      ...baseMsg,
      html: '<p>x</p><img src="cid:abc@x" alt="i"/>',
    });
    expect(out).not.toContain('cid:');
    expect(out).toContain('<p>x</p>');
  });

  it('falls back to plaintext when there is no HTML', () => {
    const out = prepareBodyForQuoting({ ...baseMsg, html: null, text: 'line1\nline2' });
    expect(out).toContain('line1');
    // Newlines become <br> (DOMPurify normalizes the self-closing form).
    expect(out).toContain('<br');
    expect(out).toMatch(/<pre>/);
  });
});

describe('buildReplyQuote (outlook, default)', () => {
  it('renders an unindented header block: From/Sent/To/Subject', () => {
    const out = buildReplyQuote(baseMsg);
    expect(out).toContain('<b>From:</b>');
    expect(out).toContain('<b>Sent:</b>');
    expect(out).toContain('<b>To:</b>');
    expect(out).toContain('<b>Subject:</b>');
    expect(out).toContain('Kevin');
    expect(out).toContain('Hi there');
  });

  it('does NOT indent the original (no blockquote, no gmail classes)', () => {
    const out = buildReplyQuote(baseMsg);
    expect(out).not.toContain('<blockquote');
    expect(out).not.toContain('gmail_quote');
    expect(out).not.toContain('wrote:');
  });

  it('marks the quote boundary with an hr carrying data-quote="original"', () => {
    const out = buildReplyQuote(baseMsg);
    expect(out).toContain('<hr data-quote="original"/>');
    // Separator sits between the header block and the original body.
    expect(out.indexOf('<b>Subject:</b>')).toBeLessThan(out.indexOf('data-quote="original"'));
    expect(out.indexOf('data-quote="original"')).toBeLessThan(out.indexOf('world'));
  });

  it('escapes header values', () => {
    const out = buildReplyQuote({
      ...baseMsg,
      subject: '<img src=x onerror=alert(1)>',
      from: { name: '<b>Kev</b>', address: 'kevin@x.com' },
    });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;b&gt;Kev&lt;/b&gt;');
  });

  it('omits the Cc line when the message has no Cc recipients', () => {
    expect(buildReplyQuote(baseMsg)).not.toContain('<b>Cc:</b>');
  });

  it('includes a Cc line when the message has Cc recipients', () => {
    const out = buildReplyQuote({ ...baseMsg, cc: [{ name: 'Bob', address: 'bob@x.com' }] });
    expect(out).toContain('<b>Cc:</b>');
    expect(out).toContain('bob@x.com');
  });

  it('still sanitizes the quoted body', () => {
    expect(buildReplyQuote(baseMsg)).not.toContain('<script');
  });
});

describe('buildReplyQuote (gmail)', () => {
  it('wraps the original in a gmail_quote blockquote with an attribution line', () => {
    const out = buildReplyQuote(baseMsg, 'gmail');
    expect(out).toContain('gmail_quote_attribution');
    expect(out).toContain('wrote:');
    expect(out).toContain('class="gmail_quote"');
    expect(out).toContain('Kevin');
    expect(out).not.toContain('<script');
  });
});

describe('buildForwardQuote (outlook, default)', () => {
  it('renders an unindented Forwarded-message header block', () => {
    const out = buildForwardQuote(baseMsg);
    expect(out).toContain('Forwarded message');
    expect(out).toContain('<b>From:</b>');
    expect(out).toContain('<b>Sent:</b>');
    expect(out).toContain('<b>To:</b>');
    expect(out).toContain('<b>Subject:</b>');
    expect(out).toContain('Hi there');
    expect(out).not.toContain('<blockquote');
    expect(out).toContain('<hr data-quote="original"/>');
  });

  it('includes a Cc line when the message has Cc recipients', () => {
    const out = buildForwardQuote({ ...baseMsg, cc: [{ name: 'Bob', address: 'bob@x.com' }] });
    expect(out).toContain('<b>Cc:</b>');
    expect(out).toContain('bob@x.com');
  });
});

describe('buildForwardQuote (gmail)', () => {
  it('renders the Forwarded-Message header block', () => {
    const out = buildForwardQuote(baseMsg, undefined, 'gmail');
    expect(out).toContain('Forwarded Message');
    expect(out).toContain('From:');
    expect(out).toContain('Subject:');
    expect(out).toContain('Date:');
    expect(out).toContain('To:');
    expect(out).toContain('Hi there');
  });

  it('wraps the quote in a gmail_quote blockquote (so the signature block can sit above it)', () => {
    const out = buildForwardQuote(baseMsg, undefined, 'gmail');
    expect(out).toContain('<blockquote class="gmail_quote"');
    expect(out.trimEnd().endsWith('</blockquote>')).toBe(true);
  });

  it('includes a Cc header line when the message has Cc recipients', () => {
    const out = buildForwardQuote(
      { ...baseMsg, cc: [{ name: 'Bob', address: 'bob@x.com' }] },
      undefined,
      'gmail',
    );
    expect(out).toContain('Cc:');
    expect(out).toContain('bob@x.com');
  });
});
