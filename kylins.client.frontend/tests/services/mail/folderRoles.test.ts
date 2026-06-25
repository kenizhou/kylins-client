import { describe, it, expect } from 'vitest';
import {
  roleFromSpecialUse,
  roleFromEasType,
  easClassOf,
  roleFromGraphWellKnown,
  roleFromNameFallback,
  roleFromGmailId,
} from '../../../src/services/mail/folders';

describe('roleFromSpecialUse (IMAP / RFC 6154)', () => {
  it.each([
    ['\\Inbox', 'inbox'],
    ['\\Sent', 'sent'],
    ['\\Drafts', 'drafts'],
    ['\\Trash', 'trash'],
    ['\\Junk', 'junk'],
    ['\\Archive', 'archive'],
    ['\\All', 'all'],
    ['\\Flagged', 'flagged'],
  ])('maps %s -> %s', (flag, role) => {
    expect(roleFromSpecialUse(flag)).toBe(role);
  });

  it('is case-insensitive', () => {
    expect(roleFromSpecialUse('\\SENT')).toBe('sent');
  });

  it('returns null for unknown / missing flags', () => {
    expect(roleFromSpecialUse('\\NoSelect')).toBeNull();
    expect(roleFromSpecialUse(null)).toBeNull();
    expect(roleFromSpecialUse(undefined)).toBeNull();
    expect(roleFromSpecialUse('')).toBeNull();
  });
});

describe('roleFromEasType (MS-ASFD Type byte)', () => {
  it.each([
    [2, 'inbox'],
    [3, 'drafts'],
    [4, 'trash'],
    [5, 'sent'],
    [6, 'outbox'],
  ])('maps type %i -> %s', (typeByte, role) => {
    expect(roleFromEasType(typeByte)).toBe(role);
  });

  it('accepts numeric strings', () => {
    expect(roleFromEasType('2')).toBe('inbox');
  });

  it('returns null for non-mail-default and user-created types (role via name fallback)', () => {
    // 1=user generic, 7=tasks, 8=calendar, 9=contacts, 12=user mail, 18=unknown
    for (const t of [1, 7, 8, 9, 10, 11, 12, 13, 18, 19]) {
      expect(roleFromEasType(t)).toBeNull();
    }
  });

  it('returns null for missing / non-numeric', () => {
    expect(roleFromEasType(null)).toBeNull();
    expect(roleFromEasType(undefined)).toBeNull();
    expect(roleFromEasType('abc')).toBeNull();
  });
});

describe('easClassOf', () => {
  it.each([
    [7, 'tasks'],
    [15, 'tasks'],
    [8, 'calendar'],
    [13, 'calendar'],
    [9, 'contacts'],
    [14, 'contacts'],
    [10, 'notes'],
    [11, 'notes'],
    [16, 'notes'],
    [17, 'notes'],
    [2, 'mail'],
    [1, 'mail'],
    [12, 'mail'],
  ])('maps type %i -> %s class', (typeByte, cls) => {
    expect(easClassOf(typeByte)).toBe(cls);
  });

  it('defaults to mail when missing', () => {
    expect(easClassOf(null)).toBe('mail');
    expect(easClassOf(undefined)).toBe('mail');
  });
});

describe('roleFromGraphWellKnown (Microsoft Graph)', () => {
  it.each([
    ['inbox', 'inbox'],
    ['sentitems', 'sent'],
    ['drafts', 'drafts'],
    ['deleteditems', 'trash'],
    ['junkemail', 'junk'],
    ['archive', 'archive'],
    ['outbox', 'outbox'],
  ])('maps %s -> %s', (name, role) => {
    expect(roleFromGraphWellKnown(name)).toBe(role);
  });

  it('returns null for non-role wellknown names and missing values', () => {
    expect(roleFromGraphWellKnown('clutter')).toBeNull();
    expect(roleFromGraphWellKnown('searchfolders')).toBeNull();
    expect(roleFromGraphWellKnown(null)).toBeNull();
    expect(roleFromGraphWellKnown(undefined)).toBeNull();
  });
});

describe('roleFromNameFallback', () => {
  it.each([
    ['Inbox', 'inbox'],
    ['Sent Items', 'sent'],
    ['Sent Mail', 'sent'],
    ['Drafts', 'drafts'],
    ['Deleted Items', 'trash'],
    ['Junk E-mail', 'junk'],
    ['Junk Email', 'junk'],
    ['Spam', 'junk'],
    ['Archive', 'archive'],
    ['Outbox', 'outbox'],
    ['Starred', 'starred'],
    ['Important', 'important'],
  ])('maps "%s" -> %s', (name, role) => {
    expect(roleFromNameFallback(name)).toBe(role);
  });

  it('returns null for unknown names', () => {
    expect(roleFromNameFallback('Project Apollo')).toBeNull();
    expect(roleFromNameFallback(null)).toBeNull();
    expect(roleFromNameFallback('')).toBeNull();
  });
});

describe('roleFromGmailId (Gmail system labels)', () => {
  it.each([
    ['INBOX', 'inbox'],
    ['SENT', 'sent'],
    ['DRAFT', 'drafts'],
    ['TRASH', 'trash'],
    ['SPAM', 'junk'],
    ['IMPORTANT', 'important'],
    ['STARRED', 'starred'],
  ])('maps %s -> %s', (id, role) => {
    expect(roleFromGmailId(id)).toBe(role);
  });

  it('returns null for user labels', () => {
    expect(roleFromGmailId('Label_1')).toBeNull();
    expect(roleFromGmailId('CATEGORY_PERSONAL')).toBeNull();
    expect(roleFromGmailId(null)).toBeNull();
  });
});
