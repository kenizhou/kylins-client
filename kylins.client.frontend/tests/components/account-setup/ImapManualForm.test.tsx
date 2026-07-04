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
  imapUsername: 'user@x.com',
  smtpHost: 'smtp.x.com',
  smtpPort: '587',
  smtpSecurity: 'starttls',
  smtpUsername: 'user@x.com',
  acceptInvalidCerts: false,
};

describe('ImapManualForm', () => {
  it('edits imap host and submits', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { getByDisplayValue, getByText, queryByTestId } = render(
      <ImapManualForm
        values={values}
        password="secret"
        onChange={onChange}
        onSubmit={onSubmit}
        onTestConnection={vi.fn()}
        canSubmit
      />,
    );
    expect(queryByTestId('kylins-mark')).not.toBeInTheDocument();
    fireEvent.change(getByDisplayValue('imap.x.com'), { target: { value: 'new.imap.com' } });
    expect(onChange).toHaveBeenCalledWith({ imapHost: 'new.imap.com' });
    fireEvent.click(getByText('Connect Account'));
    expect(onSubmit).toHaveBeenCalled();
  });

  it('pre-fills username fields and allows independent edits', () => {
    const onChange = vi.fn();
    const { getAllByDisplayValue } = render(
      <ImapManualForm
        values={values}
        password="secret"
        onChange={onChange}
        onSubmit={vi.fn()}
        canSubmit
      />,
    );
    const usernameInputs = getAllByDisplayValue('user@x.com');
    expect(usernameInputs).toHaveLength(2);
    fireEvent.change(usernameInputs[0], { target: { value: 'imap-user@x.com' } });
    expect(onChange).toHaveBeenCalledWith({ imapUsername: 'imap-user@x.com' });
  });

  it('calls test connection when the secondary button is clicked', () => {
    const onTestConnection = vi.fn();
    const { getByText } = render(
      <ImapManualForm
        values={values}
        password="secret"
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
        password="secret"
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
        password="secret"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onTestConnection={vi.fn()}
        canSubmit
        testResult={{ success: true, message: 'Connections verified.' }}
      />,
    );
    expect(getByText(/connections verified/i)).toBeInTheDocument();
  });

  it('displays field-level errors when provided', () => {
    const { getByText } = render(
      <ImapManualForm
        values={values}
        password="secret"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onTestConnection={vi.fn()}
        canSubmit={false}
        errors={{
          imapHost: 'Enter the IMAP server.',
          smtpPort: 'Enter a valid port (1–65535).',
          imapUsername: 'Enter the IMAP username.',
        }}
      />,
    );
    expect(getByText('Enter the IMAP server.')).toBeInTheDocument();
    expect(getByText('Enter a valid port (1–65535).')).toBeInTheDocument();
    expect(getByText('Enter the IMAP username.')).toBeInTheDocument();
  });
});
