import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageHeader } from '../../../src/features/viewer/MessageHeader';
import type { MailMessage } from '../../../src/features/view/viewStore';
import { formatFullDate, formatDateTimeMinutes } from '../../../src/utils/formatDate';

vi.mock('../../../src/services/settings', () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/features/classification/useSecurityIndicatorIcons', () => ({
  useSecurityIndicatorIcons: () => ({
    encryptedIcon: 'lock',
    signedIcon: 'shield',
    loaded: true,
  }),
}));

const message: MailMessage = {
  id: 'm1',
  subject: 'Security review',
  from: { name: 'Sec Team', address: 'sec@example.com' },
  to: [{ name: 'You', address: 'you@example.com' }],
  date: new Date().toISOString(),
  preview: '',
  html: '<p>x</p>',
  text: 'x',
  classificationId: null,
  isEncrypted: true,
  isSigned: true,
};

const noop = () => {};

describe('MessageHeader', () => {
  it('renders encrypted and signed badges', () => {
    render(
      <MessageHeader
        message={message}
        onReply={noop}
        onReplyAll={noop}
        onForward={noop}
        onAddContact={noop}
        contactAdded={false}
      />,
    );
    expect(screen.getByText('Encrypted')).toBeInTheDocument();
    expect(screen.getByText('Signed')).toBeInTheDocument();
  });

  it('omits security badges when message is not encrypted or signed', () => {
    render(
      <MessageHeader
        message={{ ...message, isEncrypted: false, isSigned: false }}
        onReply={noop}
        onReplyAll={noop}
        onForward={noop}
        onAddContact={noop}
        contactAdded={false}
      />,
    );
    expect(screen.queryByText('Encrypted')).not.toBeInTheDocument();
    expect(screen.queryByText('Signed')).not.toBeInTheDocument();
  });

  it('shows minute-precise time with a full-date tooltip', () => {
    const date = '2026-06-24T13:23:00Z';
    render(
      <MessageHeader
        message={{ ...message, date }}
        onReply={noop}
        onReplyAll={noop}
        onForward={noop}
        onAddContact={noop}
        contactAdded={false}
      />,
    );
    expect(screen.getByText(formatDateTimeMinutes(date))).toBeInTheDocument();
    expect(screen.getByText(formatFullDate(date))).toBeInTheDocument();
  });
});
