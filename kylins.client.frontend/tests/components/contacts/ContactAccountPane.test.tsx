import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ContactAccountPane } from '@/components/contacts/ContactAccountPane';
import type { Account } from '@/types';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    email: 'work@corp.com',
    accountLabel: 'Work',
    provider: 'imap',
    isActive: true,
    isDefault: false,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('ContactAccountPane', () => {
  it('renders All accounts and Local plus accounts', () => {
    const { getByText } = render(
      <ContactAccountPane accounts={[makeAccount()]} selectedAccountId={null} onSelect={vi.fn()} />,
    );
    expect(getByText('All accounts')).toBeInTheDocument();
    expect(getByText('Local')).toBeInTheDocument();
    expect(getByText('Work')).toBeInTheDocument();
  });

  it('calls onSelect with account id when account clicked', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <ContactAccountPane
        accounts={[makeAccount()]}
        selectedAccountId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByText('Work'));
    expect(onSelect).toHaveBeenCalledWith('acc-1');
  });

  it('calls onSelect with null when All accounts clicked', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <ContactAccountPane
        accounts={[makeAccount({ id: 'acc-1' })]}
        selectedAccountId="acc-1"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByText('All accounts'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('calls onSelect with local sentinel when Local clicked', () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <ContactAccountPane
        accounts={[makeAccount()]}
        selectedAccountId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByText('Local'));
    expect(onSelect).toHaveBeenCalledWith('local');
  });
});
