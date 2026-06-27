import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import {
  ImapManualForm,
  type ImapManualValues,
} from '../../../src/components/account-setup/ImapManualForm';

const values: ImapManualValues = {
  imapHost: 'imap.x.com',
  imapPort: '993',
  imapSecurity: 'tls',
  smtpHost: 'smtp.x.com',
  smtpPort: '587',
  smtpSecurity: 'starttls',
  acceptInvalidCerts: false,
};

describe('ImapManualForm', () => {
  it('edits imap host and submits', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { getByDisplayValue, getByText } = render(
      <ImapManualForm
        values={values}
        onChange={onChange}
        onSubmit={onSubmit}
        onTestConnection={vi.fn()}
        canSubmit
      />,
    );
    fireEvent.change(getByDisplayValue('imap.x.com'), { target: { value: 'new.imap.com' } });
    expect(onChange).toHaveBeenCalledWith({ imapHost: 'new.imap.com' });
    fireEvent.click(getByText('Connect'));
    expect(onSubmit).toHaveBeenCalled();
  });

  it('calls test connection when the secondary button is clicked', () => {
    const onTestConnection = vi.fn();
    const { getByText } = render(
      <ImapManualForm
        values={values}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onTestConnection={onTestConnection}
        canSubmit
      />,
    );
    fireEvent.click(getByText(/test connection/i));
    expect(onTestConnection).toHaveBeenCalled();
  });

  it('toggles accept invalid certificates', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ImapManualForm
        values={values}
        onChange={onChange}
        onSubmit={vi.fn()}
        onTestConnection={vi.fn()}
        canSubmit
      />,
    );
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith({ acceptInvalidCerts: true });
  });

  it('shows a success result when provided', () => {
    const { getByText } = render(
      <ImapManualForm
        values={values}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onTestConnection={vi.fn()}
        canSubmit
        testResult={{ success: true, message: 'Connections verified.' }}
      />,
    );
    expect(getByText(/connections verified/i)).toBeInTheDocument();
  });
});
