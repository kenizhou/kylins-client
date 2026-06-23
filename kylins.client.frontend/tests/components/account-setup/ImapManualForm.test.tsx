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
};

describe('ImapManualForm', () => {
  it('edits imap host and submits', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { getByDisplayValue, getByText } = render(
      <ImapManualForm values={values} onChange={onChange} onSubmit={onSubmit} canSubmit />,
    );
    fireEvent.change(getByDisplayValue('imap.x.com'), { target: { value: 'new.imap.com' } });
    expect(onChange).toHaveBeenCalledWith({ imapHost: 'new.imap.com' });
    fireEvent.click(getByText(/sign in/i));
    expect(onSubmit).toHaveBeenCalled();
  });
});
