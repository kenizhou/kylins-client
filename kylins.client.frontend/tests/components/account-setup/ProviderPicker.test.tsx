import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ProviderPicker } from '../../../src/components/account-setup/ProviderPicker';

describe('ProviderPicker', () => {
  it('renders the six provider tiles and fires onPick', () => {
    const onPick = vi.fn();
    const { getByText } = render(<ProviderPicker onPick={onPick} />);
    expect(getByText('Gmail')).toBeInTheDocument();
    expect(getByText('Outlook')).toBeInTheDocument();
    expect(getByText('Microsoft 365')).toBeInTheDocument();
    expect(getByText('Yahoo')).toBeInTheDocument();
    expect(getByText('Other (IMAP/SMTP)')).toBeInTheDocument();
    expect(getByText('Exchange (ActiveSync)')).toBeInTheDocument();
    fireEvent.click(getByText('Gmail'));
    expect(onPick).toHaveBeenCalledWith('gmail');
  });
});
