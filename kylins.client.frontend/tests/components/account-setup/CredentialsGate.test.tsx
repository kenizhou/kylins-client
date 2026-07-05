import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CredentialsGate } from '../../../src/components/account-setup/CredentialsGate';
import { getProvider } from '../../../src/services/auth/providers';

describe('CredentialsGate', () => {
  it('hides the password field for oauth providers', () => {
    const { queryByLabelText, getByPlaceholderText, queryByTestId } = render(
      <CredentialsGate
        config={getProvider('gmail')}
        displayName=""
        email=""
        password=""
        advancedClientId=""
        advancedClientSecret=""
        onChange={() => {}}
        onSignIn={() => {}}
        onManualSetup={() => {}}
        onBack={() => {}}
        canSubmit={false}
      />,
    );
    expect(queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(getByPlaceholderText(/email/i)).toBeInTheDocument();
    expect(queryByTestId('kylins-mark')).not.toBeInTheDocument();
  });

  it('shows the password field for password providers and emits sign-in', () => {
    const onSignIn = vi.fn();
    const { getByLabelText, getByText, queryByTestId } = render(
      <CredentialsGate
        config={getProvider('yahoo')}
        displayName=""
        email=""
        password=""
        advancedClientId=""
        advancedClientSecret=""
        onChange={() => {}}
        onSignIn={onSignIn}
        onManualSetup={() => {}}
        onBack={() => {}}
        canSubmit
      />,
    );
    expect(getByLabelText(/password/i)).toBeInTheDocument();
    expect(queryByTestId('kylins-mark')).not.toBeInTheDocument();
    fireEvent.click(getByText(/continue/i));
    expect(onSignIn).toHaveBeenCalled();
  });

  it('submits the form when Enter is pressed in an input', () => {
    const onSignIn = vi.fn();
    const { container } = render(
      <CredentialsGate
        config={getProvider('yahoo')}
        displayName=""
        email=""
        password=""
        advancedClientId=""
        advancedClientSecret=""
        onChange={() => {}}
        onSignIn={onSignIn}
        onManualSetup={() => {}}
        onBack={() => {}}
        canSubmit
      />,
    );
    fireEvent.submit(container.querySelector('form')!);
    expect(onSignIn).toHaveBeenCalled();
  });

  it('displays field-level errors when errors are provided', () => {
    const { getByText } = render(
      <CredentialsGate
        config={getProvider('yahoo')}
        displayName=""
        email=""
        password=""
        advancedClientId=""
        advancedClientSecret=""
        onChange={() => {}}
        onSignIn={() => {}}
        onManualSetup={() => {}}
        onBack={() => {}}
        canSubmit={false}
        errors={{ email: 'Enter your email address.', password: 'Enter your password.' }}
      />,
    );
    expect(getByText('Enter your email address.')).toBeInTheDocument();
    expect(getByText('Enter your password.')).toBeInTheDocument();
  });
});
