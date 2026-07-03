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
    const { getByText, getByRole } = render(
      <AccountSetupFlow variant="modal" onComplete={onComplete} />,
    );
    expect(getByText('Welcome to Kylins Mail')).toBeInTheDocument();
    fireEvent.click(getByText('Yahoo'));
    expect(getByRole('heading', { name: /Add your account/i })).toBeInTheDocument();
  });

  it('announces the current step via a polite live region', () => {
    const { getByText, container } = render(
      <AccountSetupFlow variant="modal" onComplete={vi.fn()} />,
    );
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'Choose your email provider.',
    );
    fireEvent.click(getByText('Yahoo'));
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('Add your account.');
  });

  it('focuses the step heading after navigation', () => {
    const { getByText, getByRole } = render(
      <AccountSetupFlow variant="modal" onComplete={vi.fn()} />,
    );
    fireEvent.click(getByText('Yahoo'));
    const heading = getByRole('heading', { name: /Add your account/i });
    expect(heading).toHaveAttribute('tabIndex', '-1');
    expect(heading).toHaveFocus();
  });
});
