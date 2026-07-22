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

describe('buildReplyQuote', () => {
  it('wraps the original in a gmail_quote blockquote with an attribution line', () => {
    const out = buildReplyQuote(baseMsg);
    expect(out).toContain('gmail_quote_attribution');
    expect(out).toContain('wrote:');
    expect(out).toContain('class="gmail_quote"');
    expect(out).toContain('Kevin');
    expect(out).not.toContain('<script');
  });
});

describe('buildForwardQuote', () => {
  it('renders the Forwarded-Message header block', () => {
    const out = buildForwardQuote(baseMsg);
    expect(out).toContain('Forwarded Message');
    expect(out).toContain('From:');
    expect(out).toContain('Subject:');
    expect(out).toContain('Date:');
    expect(out).toContain('To:');
    expect(out).toContain('Hi there');
  });

  it('wraps the quote in a gmail_quote blockquote (so the signature block can sit above it)', () => {
    const out = buildForwardQuote(baseMsg);
    expect(out).toContain('<blockquote class="gmail_quote"');
    expect(out.trimEnd().endsWith('</blockquote>')).toBe(true);
  });

  it('includes a Cc header line when the message has Cc recipients', () => {
    const out = buildForwardQuote({ ...baseMsg, cc: [{ name: 'Bob', address: 'bob@x.com' }] });
    expect(out).toContain('Cc:');
    expect(out).toContain('bob@x.com');
  });
});
