import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { VerifyStep } from '../../../src/components/account-setup/VerifyStep';
import { WelcomeScreen } from '../../../src/components/account-setup/WelcomeScreen';

describe('VerifyStep', () => {
  it('shows the error and retry', () => {
    const onRetry = vi.fn();
    const { getByText } = render(
      <VerifyStep error="bad creds" onRetry={onRetry} onBack={() => {}} />,
    );
    expect(getByText(/bad creds/)).toBeInTheDocument();
    fireEvent.click(getByText(/retry/i));
    expect(onRetry).toHaveBeenCalled();
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
