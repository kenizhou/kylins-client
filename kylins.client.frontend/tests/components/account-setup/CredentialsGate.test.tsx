import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CredentialsGate } from '../../../src/components/account-setup/CredentialsGate';
import { getProvider } from '../../../src/services/auth/providers';

describe('CredentialsGate', () => {
  it('hides the password field for oauth providers', () => {
    const { queryByLabelText, getByPlaceholderText } = render(
      <CredentialsGate
        config={getProvider('gmail')}
        email=""
        password=""
        advancedClientId=""
        advancedClientSecret=""
        onChange={() => {}}
        onSignIn={() => {}}
        onManualSetup={() => {}}
        canSubmit={false}
      />,
    );
    expect(queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(getByPlaceholderText(/email/i)).toBeInTheDocument();
  });

  it('shows the password field for password providers and emits sign-in', () => {
    const onSignIn = vi.fn();
    const { getByLabelText, getByText } = render(
      <CredentialsGate
        config={getProvider('yahoo')}
        email=""
        password=""
        advancedClientId=""
        advancedClientSecret=""
        onChange={() => {}}
        onSignIn={onSignIn}
        onManualSetup={() => {}}
        canSubmit
      />,
    );
    expect(getByLabelText(/password/i)).toBeInTheDocument();
    fireEvent.click(getByText(/sign in/i));
    expect(onSignIn).toHaveBeenCalled();
  });
});
