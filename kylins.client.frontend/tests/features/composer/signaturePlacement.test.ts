import { describe, it, expect } from 'vitest';
import { stripSignature } from '@/features/composer/signaturePlacement';

describe('stripSignature (send-time unwrap)', () => {
  it('unwraps the signature tag but keeps its visible content', () => {
    expect(stripSignature('Hi<signature id="s"><p>-- me</p></signature>')).toBe('Hi<p>-- me</p>');
  });

  it('unwraps multiple signature blocks', () => {
    expect(
      stripSignature(
        '<p>a</p><signature id="s1"><p>one</p></signature><signature id="s2">two</signature>',
      ),
    ).toBe('<p>a</p><p>one</p>two');
  });

  it('leaves bodies without a signature untouched (minus trailing whitespace)', () => {
    expect(stripSignature('<p>hello</p>')).toBe('<p>hello</p>');
  });
});
