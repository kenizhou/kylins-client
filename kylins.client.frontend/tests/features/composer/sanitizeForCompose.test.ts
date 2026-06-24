import { describe, it, expect } from 'vitest';
import { sanitizeForCompose } from '@/services/composer/sanitizeForCompose';

describe('sanitizeForCompose', () => {
  it('strips <script> (delegates to the viewer policy)', () => {
    expect(sanitizeForCompose('<p>ok</p><script>alert(1)</script>')).not.toContain('<script');
  });

  it('strips <form>', () => {
    expect(sanitizeForCompose('<p>ok</p><form><input/></form>')).not.toContain('<form');
  });

  it('keeps ordinary markup', () => {
    expect(sanitizeForCompose('<p>hello <b>world</b></p>')).toContain('<b>world</b>');
  });
});
