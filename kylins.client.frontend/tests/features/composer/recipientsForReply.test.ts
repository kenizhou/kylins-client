import { describe, it, expect } from 'vitest';
import {
  participantsForReply,
  participantsForReplyAll,
} from '@/features/composer/recipientsForReply';

const SELF = ['me@x.com'];

const msg = {
  from: { name: 'Kevin', address: 'kevin@x.com' },
  to: [
    { name: 'Me', address: 'me@x.com' },
    { name: 'Ann', address: 'ann@x.com' },
  ],
  cc: [{ name: 'Bob', address: 'bob@x.com' }],
};

describe('participantsForReply', () => {
  it('replies to the sender only', () => {
    expect(participantsForReply(msg, SELF).to).toEqual([{ name: 'Kevin', email: 'kevin@x.com' }]);
  });

  it('uses Reply-To when present and not self', () => {
    const out = participantsForReply(
      { ...msg, replyTo: [{ name: 'List', address: 'list@x.com' }] },
      SELF,
    );
    expect(out.to).toEqual([{ name: 'List', email: 'list@x.com' }]);
  });
});

describe('participantsForReplyAll', () => {
  it('puts the sender in To and everyone else (minus self) in Cc', () => {
    const out = participantsForReplyAll(msg, SELF);
    expect(out.to).toEqual([{ name: 'Kevin', email: 'kevin@x.com' }]);
    expect(out.cc).toEqual([
      { name: 'Ann', email: 'ann@x.com' },
      { name: 'Bob', email: 'bob@x.com' },
    ]);
  });

  it('uses Reply-To for To when present', () => {
    const out = participantsForReplyAll(
      { ...msg, replyTo: [{ name: 'List', address: 'list@x.com' }] },
      SELF,
    );
    expect(out.to).toEqual([{ name: 'List', email: 'list@x.com' }]);
    // Sender is excluded from Cc; self excluded; Ann & Bob remain.
    expect(out.cc).toEqual([
      { name: 'Ann', email: 'ann@x.com' },
      { name: 'Bob', email: 'bob@x.com' },
    ]);
  });

  it('when I sent the message, replies to the original To/Cc (minus self)', () => {
    const out = participantsForReplyAll(
      { ...msg, from: { name: 'Me', address: 'me@x.com' } },
      SELF,
    );
    expect(out.to).toEqual([{ name: 'Ann', email: 'ann@x.com' }]);
    expect(out.cc).toEqual([{ name: 'Bob', email: 'bob@x.com' }]);
  });

  it('dedupes by email', () => {
    const out = participantsForReplyAll(
      { ...msg, to: [...msg.to, { name: 'Ann Again', address: 'ann@x.com' }] },
      SELF,
    );
    expect(out.cc.filter((r) => r.email === 'ann@x.com')).toHaveLength(1);
  });
});
