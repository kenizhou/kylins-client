import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { EasManualForm } from '../../../src/components/account-setup/EasManualForm';

describe('EasManualForm', () => {
  it('shows the device id and submits', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { getByDisplayValue, getByText } = render(
      <EasManualForm
        server="https://ex.com/Microsoft-Server-ActiveSync"
        deviceId="DEV-1"
        onChange={onChange}
        onSubmit={onSubmit}
        canSubmit
      />,
    );
    expect(getByDisplayValue('DEV-1')).toBeInTheDocument();
    fireEvent.click(getByText(/connect/i));
    expect(onSubmit).toHaveBeenCalled();
  });
});
