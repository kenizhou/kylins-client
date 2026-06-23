import { describe, it, expect } from 'vitest';
import { inlineCss } from '../../../src/services/composer/juiceInline';

describe('composer/juiceInline', () => {
  it('inlines <style> rules onto matching elements and strips the <style> tag', () => {
    const html = '<style>.red{color:red}</style><p class="red">Hi</p>';
    const out = inlineCss(html);
    expect(out).toMatch(/color:\s*red/i);
    expect(out).not.toContain('<style');
    expect(out).toContain('Hi');
  });

  it('returns empty input unchanged', () => {
    expect(inlineCss('')).toBe('');
  });

  it('passes through HTML with no styles untouched (text preserved)', () => {
    const out = inlineCss('<p>Hi</p>');
    expect(out).toContain('<p>Hi</p>');
  });
});
