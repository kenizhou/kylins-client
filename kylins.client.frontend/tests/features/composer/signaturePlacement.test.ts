import { describe, it, expect } from 'vitest';
import {
  applySignatureAboveQuote,
  stripSignature,
  removeSignature,
} from '@/features/composer/signaturePlacement';

describe('applySignatureAboveQuote', () => {
  it('appends the signature at the end when there is no quote', () => {
    expect(applySignatureAboveQuote('Hello', { id: 's1', html: '<p>regards</p>' })).toBe(
      'Hello<signature id="s1"><p>regards</p></signature>',
    );
  });

  it('places the signature before the gmail_quote block', () => {
    const body = '<p>my reply</p><blockquote class="gmail_quote">orig</blockquote>';
    expect(applySignatureAboveQuote(body, { id: 's1', html: '<p>sig</p>' })).toBe(
      '<p>my reply</p><signature id="s1"><p>sig</p></signature><blockquote class="gmail_quote">orig</blockquote>',
    );
  });

  it('replaces an existing signature', () => {
    const body = 'Hello<signature id="old"><p>old</p></signature>';
    expect(applySignatureAboveQuote(body, { id: 'new', html: '<p>new</p>' })).toBe(
      'Hello<signature id="new"><p>new</p></signature>',
    );
  });

  it('removes the signature entirely when passed null', () => {
    const body = 'Hello<signature id="old"><p>old</p></signature>';
    expect(applySignatureAboveQuote(body, null)).toBe('Hello');
  });
});

describe('stripSignature (send-time unwrap)', () => {
  it('unwraps the signature tag but keeps its visible content', () => {
    expect(stripSignature('Hi<signature id="s"><p>-- me</p></signature>')).toBe('Hi<p>-- me</p>');
  });
});

describe('removeSignature', () => {
  it('removes the signature tag and its content', () => {
    expect(removeSignature('Hello<signature id="x"><p>s</p></signature>')).toBe('Hello');
  });
});
