import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { render, fireEvent } from '@testing-library/react';
import { AccountSetupFlow } from '../../../src/components/account-setup/AccountSetupFlow';
import { useAccountSetupStore } from '../../../src/stores/accountSetupStore';

describe('AccountSetupFlow', () => {
  beforeEach(() => useAccountSetupStore.getState().reset());

  it('renders the picker first and advances to gateway on pick', () => {
    const onComplete = vi.fn();
    const { getByText, queryByText } = render(
      <AccountSetupFlow variant="modal" onComplete={onComplete} />,
    );
    expect(getByText('Welcome to Kylins Mail')).toBeInTheDocument();
    fireEvent.click(getByText('Yahoo'));
    // gateway visible (password field shown for yahoo)
    expect(queryByText(/Add your account/i)).toBeInTheDocument();
  });
});
