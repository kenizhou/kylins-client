import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { VerifyStep } from '../../../src/components/account-setup/VerifyStep';
import { WelcomeScreen } from '../../../src/components/account-setup/WelcomeScreen';

describe('VerifyStep', () => {
  it('shows the error and retry', () => {
    const onRetry = vi.fn();
    const { getByText, getByRole } = render(
      <VerifyStep error="bad creds" onRetry={onRetry} onBack={() => {}} />,
    );
    expect(getByRole('alert')).toHaveTextContent(/bad creds/);
    fireEvent.click(getByText(/retry/i));
    expect(onRetry).toHaveBeenCalled();
  });

  it('opens a confirmation dialog before replacing an existing account', () => {
    const onReplace = vi.fn();
    const { getByText, queryByText } = render(
      <VerifyStep
        error="An account for user@example.com already exists"
        onRetry={() => {}}
        onBack={() => {}}
        onReplace={onReplace}
      />,
    );
    fireEvent.click(getByText(/replace existing account/i));
    expect(getByText('Replace account?')).toBeInTheDocument();
    fireEvent.click(getByText('Cancel'));
    expect(queryByText('Replace account?')).not.toBeInTheDocument();
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('confirms replacement and calls onReplace', () => {
    const onReplace = vi.fn();
    const { getByText, queryByText } = render(
      <VerifyStep
        error="An account for user@example.com already exists"
        onRetry={() => {}}
        onBack={() => {}}
        onReplace={onReplace}
      />,
    );
    fireEvent.click(getByText(/replace existing account/i));
    expect(getByText('Replace account?')).toBeInTheDocument();
    fireEvent.click(getByText('Replace account'));
    expect(queryByText('Replace account?')).not.toBeInTheDocument();
    expect(onReplace).toHaveBeenCalled();
  });
});

describe('WelcomeScreen', () => {
  it('fires onDone', () => {
    const onDone = vi.fn();
    const { getByText } = render(<WelcomeScreen onDone={onDone} />);
    fireEvent.click(getByText(/open inbox/i));
    expect(onDone).toHaveBeenCalled();
  });
});
