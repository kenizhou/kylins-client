import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { EasManualForm } from '../../../src/components/account-setup/EasManualForm';

describe('EasManualForm', () => {
  it('shows the device id and submits', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { getByDisplayValue, getByText, queryByTestId } = render(
      <EasManualForm
        server="https://ex.com/Microsoft-Server-ActiveSync"
        deviceId="DEV-1"
        onChange={onChange}
        onSubmit={onSubmit}
        canSubmit
      />,
    );
    expect(queryByTestId('kylins-mark')).not.toBeInTheDocument();
    expect(getByDisplayValue('DEV-1')).toBeInTheDocument();
    fireEvent.click(getByText(/connect/i));
    expect(onSubmit).toHaveBeenCalled();
  });

  it('displays field-level errors when provided', () => {
    const { getByText } = render(
      <EasManualForm
        server=""
        deviceId=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        canSubmit={false}
        errors={{ server: 'Enter the Exchange server URL.', deviceId: 'Enter a device ID.' }}
      />,
    );
    expect(getByText('Enter the Exchange server URL.')).toBeInTheDocument();
    expect(getByText('Enter a device ID.')).toBeInTheDocument();
  });
});
