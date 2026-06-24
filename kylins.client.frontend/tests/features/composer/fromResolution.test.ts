import { describe, it, expect } from 'vitest';
import type { SendAsAlias } from '@/services/db/sendAsAliases';
import { resolveFromForReply } from '@/features/composer/fromResolution';

function alias(email: string, name: string | null): SendAsAlias {
  return {
    id: email,
    email,
    displayName: name,
    replyTo: null,
    signatureId: null,
    isPrimary: false,
    isDefault: false,
    verificationStatus: 'accepted',
  };
}

describe('resolveFromForReply', () => {
  it('returns the default when no alias matches a recipient', () => {
    const def = alias('default@x.com', 'Default');
    const out = resolveFromForReply(
      { to: [{ name: 'X', address: 'someone@else.com' }], cc: [] },
      [alias('sales@x.com', 'Sales')],
      def,
    );
    expect(out).toBe(def);
  });

  it('prefers an alias whose email matches a recipient', () => {
    const def = alias('default@x.com', 'Default');
    const sales = alias('sales@x.com', 'Sales');
    const out = resolveFromForReply(
      { to: [{ name: 'Me', address: 'sales@x.com' }], cc: [] },
      [sales],
      def,
    );
    expect(out.email).toBe('sales@x.com');
  });

  it('returns an exact name+email match immediately', () => {
    const def = alias('default@x.com', 'Default');
    const sales = alias('sales@x.com', 'Sales Team');
    const out = resolveFromForReply(
      { to: [{ name: 'Sales Team', address: 'sales@x.com' }], cc: [] },
      [sales],
      def,
    );
    expect(out).toBe(sales);
  });

  it('considers Cc recipients too', () => {
    const def = alias('default@x.com', 'Default');
    const support = alias('support@x.com', 'Support');
    const out = resolveFromForReply(
      {
        to: [{ name: 'X', address: 'other@x.com' }],
        cc: [{ name: 'Support', address: 'support@x.com' }],
      },
      [support],
      def,
    );
    expect(out.email).toBe('support@x.com');
  });

  it('falls back to default with an empty alias list', () => {
    const def = alias('default@x.com', 'Default');
    expect(resolveFromForReply({ to: [{ name: 'X', address: 'a@b.com' }] }, [], def)).toBe(def);
  });
});
