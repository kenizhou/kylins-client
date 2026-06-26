import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { ReadingPane } from '../../../src/components/layout/ReadingPane';
import { useViewStore } from '../../../src/features/view/viewStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import { useClassificationStore } from '../../../src/features/classification/classificationStore';
import type { MailMessage } from '../../../src/features/view/viewStore';

vi.mock('../../../src/services/db/connection', async () => {
  const mockDb = {
    select: vi.fn(async () => []),
    execute: vi.fn(async () => 0),
  };
  return {
    getDb: vi.fn(async () => mockDb),
    withTransaction: vi.fn(async (fn: (db: unknown) => Promise<void>) => fn(mockDb)),
    boolToInt: (b: boolean) => (b ? 1 : 0),
    selectFirstBy: vi.fn(async () => null),
    buildDynamicUpdate: vi.fn(() => null),
  };
});

vi.mock('../../../src/components/plugins/InjectedComponentSet', () => ({
  InjectedComponentSet: () => null,
}));

vi.mock('../../../src/components/email/EmailRenderer', () => ({
  EmailRenderer: () => <div data-testid="email-renderer" />,
}));

vi.mock('../../../src/components/email/InlineReply', () => ({
  InlineReply: () => <div data-testid="inline-reply" />,
}));

const message: MailMessage = {
  id: 'msg-1',
  subject: 'Test subject',
  from: { name: 'Test Sender', address: 'sender@example.com' },
  to: [{ name: 'You', address: 'you@example.com' }],
  date: new Date().toISOString(),
  preview: 'Preview text',
  html: '<p>Hello</p>',
  text: 'Hello',
  threadId: 'thread-1',
  classificationId: null,
  isEncrypted: false,
  isSigned: false,
};

describe('ReadingPane', () => {
  beforeEach(() => {
    useViewStore.setState({ selectedMessage: null });
    useAccountStore.setState({
      accounts: [
        { id: 'acc-1', email: 'you@example.com' } as unknown as Parameters<
          typeof useAccountStore.setState
        >[0]['accounts'][number],
      ],
      activeAccountId: 'acc-1',
      defaultAccountId: 'acc-1',
    });
    usePreferencesStore.setState({ automaticallyLoadImages: false } as Parameters<
      typeof usePreferencesStore.setState
    >[0]);
    useClassificationStore.setState({
      levels: [
        { id: 'unclassified', name: 'Unclassified', color: '#6b7280', icon: null, order: 0 },
        { id: 'restricted', name: 'Restricted', color: '#f59e0b', icon: 'shield', order: 1 },
        { id: 'confidential', name: 'Confidential', color: '#ef4444', icon: 'lock', order: 2 },
      ],
      loaded: false,
    });
  });

  it('renders the selected message after starting with no selection', async () => {
    const { getByText, queryByText } = render(<ReadingPane />);
    expect(getByText('No message selected')).toBeInTheDocument();

    act(() => {
      useViewStore.setState({ selectedMessage: message });
    });

    await waitFor(() => {
      expect(queryByText('No message selected')).not.toBeInTheDocument();
      expect(getByText('Test subject')).toBeInTheDocument();
    });
  });
});
