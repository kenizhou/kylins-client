import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SignaturesPreferences } from '../../../src/components/preferences/SignaturesPreferences';
import { useAccountStore } from '../../../src/stores/accountStore';
import { wireDefaultDbResults, defaultDbResult } from '@/test/mockInvoke';
import type { DbSignature } from '../../../src/services/db/signatures';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    email: 'user@example.com',
    displayName: 'User',
    provider: 'imap' as const,
    authMethod: 'password',
    isActive: true,
    isDefault: true,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const workSig: DbSignature = {
  id: 'sig-1',
  account_id: 'a1',
  name: 'Work',
  body_html: '<p>Regards, User</p>',
  is_default: 1,
  sort_order: 0,
  context: 'all',
};

function seedSignatures(sigs: DbSignature[]) {
  mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'db_get_signatures_for_account') return sigs;
    return defaultDbResult(cmd, args);
  });
}

describe('SignaturesPreferences', () => {
  beforeEach(() => {
    wireDefaultDbResults(mockInvoke);
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  });

  it('shows an empty state when no accounts exist', () => {
    render(<SignaturesPreferences />);
    expect(screen.getByText(/add an account before creating signatures/i)).toBeInTheDocument();
  });

  it('lists the signatures for the selected account', async () => {
    useAccountStore.setState({ accounts: [makeAccount()], activeAccountId: 'a1' });
    seedSignatures([workSig]);
    render(<SignaturesPreferences />);

    expect(await screen.findByText('Work')).toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();
    // "Default" badge appears on both the account chip and the signature row.
    expect(screen.getAllByText('Default')).toHaveLength(2);
  });

  it('shows the empty-list message when the account has no signatures', async () => {
    useAccountStore.setState({ accounts: [makeAccount()], activeAccountId: 'a1' });
    seedSignatures([]);
    render(<SignaturesPreferences />);

    expect(await screen.findByText(/no signatures for this account yet/i)).toBeInTheDocument();
  });

  it('creates a new signature through the editor', async () => {
    useAccountStore.setState({ accounts: [makeAccount()], activeAccountId: 'a1' });
    seedSignatures([]);
    render(<SignaturesPreferences />);

    fireEvent.click(await screen.findByRole('button', { name: /add signature/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Casual' } });
    fireEvent.click(screen.getByRole('button', { name: /save signature/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'db_insert_signature',
        expect.objectContaining({
          input: expect.objectContaining({ accountId: 'a1', name: 'Casual' }),
        }),
      );
    });
  });

  it('opens an existing signature for edit and saves via update', async () => {
    useAccountStore.setState({ accounts: [makeAccount()], activeAccountId: 'a1' });
    seedSignatures([workSig]);
    render(<SignaturesPreferences />);

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Work (updated)' } });
    fireEvent.click(screen.getByRole('button', { name: /save signature/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'db_update_signature',
        expect.objectContaining({
          id: 'sig-1',
          updates: expect.objectContaining({ name: 'Work (updated)' }),
        }),
      );
    });
  });

  it('deletes a signature', async () => {
    useAccountStore.setState({ accounts: [makeAccount()], activeAccountId: 'a1' });
    seedSignatures([workSig]);
    render(<SignaturesPreferences />);

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('db_delete_signature', { id: 'sig-1' });
    });
  });
});
