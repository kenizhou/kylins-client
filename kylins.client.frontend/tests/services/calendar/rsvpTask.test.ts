import { describe, it, expect } from 'vitest';
import { buildRsvpReply, partstatToEasResponse } from '../../../src/services/calendar/rsvpTask';
import type { SendAsAlias } from '../../../src/services/db/sendAsAliases';

const responder: SendAsAlias = {
  id: 'a',
  email: 'me@corp.com',
  displayName: 'Me',
  replyTo: null,
  signatureId: null,
  isPrimary: true,
  isDefault: true,
  verificationStatus: 'accepted',
};

describe('calendar/rsvpTask', () => {
  it('builds a METHOD:REPLY with the responder PARTSTAT', () => {
    const ics = buildRsvpReply({
      uid: 'evt-1',
      summary: 'M',
      start: new Date('2025-06-20T14:00:00Z'),
      end: new Date('2025-06-20T15:00:00Z'),
      organizerEmail: 'org@corp.com',
      responder,
      partstat: 'ACCEPTED',
    });
    expect(ics).toContain('METHOD:REPLY');
    expect(ics).toContain('PARTSTAT=ACCEPTED');
    expect(ics).toContain('mailto:me@corp.com');
  });

  it('maps partstat to EAS UserResponse codes', () => {
    expect(partstatToEasResponse('ACCEPTED')).toBe('1');
    expect(partstatToEasResponse('TENTATIVE')).toBe('2');
    expect(partstatToEasResponse('DECLINED')).toBe('3');
  });
});
