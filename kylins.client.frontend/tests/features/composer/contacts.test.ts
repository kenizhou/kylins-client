import { describe, it, expect } from 'vitest';
import {
  parseRecipient,
  parseRecipients,
  formatRecipient,
  formatRecipients,
  isValidEmail,
  normalizeEmail,
  toRecipient,
} from '@/features/composer/contacts';

describe('isValidEmail', () => {
  it('accepts a normal address', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
  });
  it('rejects a missing TLD', () => {
    expect(isValidEmail('a@b')).toBe(false);
  });
  it('rejects empty', () => {
    expect(isValidEmail('')).toBe(false);
  });
  it('rejects spaces inside', () => {
    expect(isValidEmail('a b@c.com')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(isValidEmail('A@B.COM')).toBe(true);
  });
});

describe('normalizeEmail', () => {
  it('strips angle brackets', () => {
    expect(normalizeEmail('<a@b.com>')).toBe('a@b.com');
  });
  it('strips surrounding quotes', () => {
    expect(normalizeEmail('"a@b.com"')).toBe('a@b.com');
  });
});

describe('parseRecipient', () => {
  it('parses Name <email>', () => {
    expect(parseRecipient('Jane Doe <jane@example.com>')).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
    });
  });
  it('parses a quoted name with a comma', () => {
    expect(parseRecipient('"Doe, John" <john@example.com>')).toEqual({
      name: 'Doe, John',
      email: 'john@example.com',
    });
  });
  it('parses a bare email', () => {
    expect(parseRecipient('a@b.com')).toEqual({ name: 'a@b.com', email: 'a@b.com' });
  });
  it('parses the paren form', () => {
    expect(parseRecipient('Jane (jane@example.com)')).toEqual({
      name: 'Jane',
      email: 'jane@example.com',
    });
  });
  it('returns null for empty input', () => {
    expect(parseRecipient('   ')).toBeNull();
  });
  it('keeps unparseable text as an invalid recipient', () => {
    const r = parseRecipient('not an email');
    expect(r).toEqual({ name: 'not an email', email: 'not an email' });
    expect(isValidEmail(r!.email)).toBe(false);
  });
});

describe('parseRecipients', () => {
  it('splits a comma list', () => {
    expect(parseRecipients('a@b.com, c@d.com')).toEqual([
      { name: 'a@b.com', email: 'a@b.com' },
      { name: 'c@d.com', email: 'c@d.com' },
    ]);
  });
  it('keeps a comma inside a quoted name', () => {
    expect(parseRecipients('"Doe, John" <john@example.com>, jane@example.com')).toEqual([
      { name: 'Doe, John', email: 'john@example.com' },
      { name: 'jane@example.com', email: 'jane@example.com' },
    ]);
  });
  it('handles multiple angle-form recipients', () => {
    expect(parseRecipients('Ann <ann@x.com>; Bob <bob@x.com>')).toEqual([
      { name: 'Ann', email: 'ann@x.com' },
      { name: 'Bob', email: 'bob@x.com' },
    ]);
  });
  it('returns one invalid recipient when no email is found', () => {
    expect(parseRecipients('hello there')).toEqual([{ name: 'hello there', email: 'hello there' }]);
  });
  it('returns [] for empty input', () => {
    expect(parseRecipients('')).toEqual([]);
  });
});

describe('formatRecipient', () => {
  it('formats a named recipient', () => {
    expect(formatRecipient({ name: 'Jane', email: 'jane@x.com' })).toBe('Jane <jane@x.com>');
  });
  it('omits the name when it equals the email', () => {
    expect(formatRecipient({ name: 'jane@x.com', email: 'jane@x.com' })).toBe('jane@x.com');
  });
  it('quotes names containing commas', () => {
    expect(formatRecipient({ name: 'Doe, John', email: 'john@x.com' })).toBe(
      '"Doe, John" <john@x.com>',
    );
  });
  it('round-trips a quoted-name parse', () => {
    const r = parseRecipients('"Doe, John" <john@example.com>')[0]!;
    expect(formatRecipient(r)).toBe('"Doe, John" <john@example.com>');
  });
});

describe('formatRecipients / toRecipient', () => {
  it('maps a list', () => {
    expect(
      formatRecipients([
        { name: 'a@b.com', email: 'a@b.com' },
        { name: 'Jane', email: 'j@b.com' },
      ]),
    ).toEqual(['a@b.com', 'Jane <j@b.com>']);
  });
  it('toRecipient falls back to address when name is empty', () => {
    expect(toRecipient({ name: '', address: 'x@y.com' })).toEqual({
      name: 'x@y.com',
      email: 'x@y.com',
    });
  });
});
