import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { OAuthPendingScreen } from '../../../src/components/account-setup/OAuthPendingScreen';

describe('OAuthPendingScreen', () => {
  it('renders the provider name and a copyable fallback url', () => {
    const { getByText, getByDisplayValue } = render(
      <OAuthPendingScreen
        providerName="Google"
        fallbackUrl="https://accounts.google.com/x?client_id=CID"
        onCancel={vi.fn()}
      />,
    );
    expect(getByText(/Sign in with Google in your browser/i)).toBeInTheDocument();
    expect(getByDisplayValue(/client_id=CID/)).toBeInTheDocument();
  });

  it('fires onCancel', () => {
    const onCancel = vi.fn();
    const { getByText } = render(
      <OAuthPendingScreen providerName="Google" fallbackUrl="u" onCancel={onCancel} />,
    );
    fireEvent.click(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
