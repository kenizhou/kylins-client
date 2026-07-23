// End-to-end integration test for the docked inline composer: real ReadingPane
// + real InlineReply + real stores (only Tauri/send boundaries mocked).
// Reproduces the user flow: select a message → click Reply → dock appears
// with the seeded quote → send works. (ReadingPane.test.tsx mocks InlineReply,
// so this wiring was previously untested.)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/appdata'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => false),
  remove: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  readFile: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

const { mockSendEmail } = vi.hoisted(() => ({ mockSendEmail: vi.fn() }));
vi.mock('../../../src/services/composer/send', () => ({ sendEmail: mockSendEmail }));

vi.mock('../../../src/services/db/attachments', () => ({
  getAttachments: vi.fn(async () => []),
  fetchAttachment: vi.fn(),
  fetchInlineImages: vi.fn(async () => []),
  cachedImageToDataUrl: vi.fn(async () => 'data:'),
  referencedCids: () => new Set<string>(),
}));

vi.mock('../../../src/components/plugins/InjectedComponentSet', () => ({
  InjectedComponentSet: () => null,
}));

vi.mock('../../../src/features/viewer/RsvpCard', () => ({
  RsvpCard: () => null,
}));

// jsdom lacks matchMedia (used by EmailRenderer's dark-mode check).
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

import { ReadingPane } from '../../../src/components/layout/ReadingPane';
import { useViewStore } from '../../../src/features/view/viewStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { useThreadStore } from '../../../src/stores/threadStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import { useInlineComposerStore } from '../../../src/stores/inlineComposerStore';
import { useClassificationStore } from '../../../src/features/classification/classificationStore';
import type { MailMessage } from '../../../src/features/view/viewStore';

const message: MailMessage = {
  id: 'msg-1',
  subject: 'Q2 IT Infrastructure Upgrade',
  from: { name: 'David Chen', address: 'david@example.com' },
  to: [{ name: 'Me', address: 'me@example.com' }],
  cc: [],
  replyTo: [],
  date: new Date('2026-07-20T09:00:00Z').toISOString(),
  preview: 'preview',
  html: '<p>Please review the proposal.</p>',
  text: 'Please review the proposal.',
  threadId: 't1',
  messageId: '<mid-1@example.com>',
  classificationId: null,
  isEncrypted: false,
  isSigned: false,
};

describe('ReadingPane + InlineReply integration', () => {
  beforeEach(() => {
    useViewStore.setState({ selectedMessage: message });
    useThreadStore.setState({
      threads: [{ id: 't1', accountId: 'acc-1', subject: 'x', isRead: true } as never],
      selectedThreadId: 't1',
    });
    useAccountStore.setState({
      accounts: [{ id: 'acc-1', email: 'me@example.com', displayName: 'Me' } as never],
      activeAccountId: 'acc-1',
    });
    usePreferencesStore.setState({
      quoteStyle: 'outlook',
      automaticallyLoadImages: true,
      alwaysShowCcBcc: false,
    } as never);
    useInlineComposerStore.setState({ session: null });
    useClassificationStore.setState({ levels: [], loaded: true } as never);
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_aliases_for_account') return [];
      if (cmd === 'db_get_signatures_for_account') return [];
      if (cmd === 'db_get_default_signature') return null;
      return undefined;
    });
    mockSendEmail.mockReset();
  });

  it('clicking Reply opens the composer takeover with the seeded Outlook quote', async () => {
    render(<ReadingPane />);

    // Message renders before reply.
    await waitFor(() =>
      expect(screen.getByText('Q2 IT Infrastructure Upgrade')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /^reply$/i }));

    // The composer replaces the message view, fully visible: header, address
    // fields, toolbar, editor, and send bar.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument();
    });
    const editorEl = document.querySelector('.kylins-editor');
    expect(editorEl).not.toBeNull();
    await waitFor(() => {
      expect(document.querySelector('.kylins-editor')?.innerHTML).toContain('From:');
    });
    expect(document.querySelector('.kylins-editor')?.innerHTML).toContain('data-quote="original"');
    // Recipient seeded from the sender; subject prefixed.
    expect(screen.getByTitle('david@example.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Re: Q2 IT Infrastructure Upgrade')).toBeInTheDocument();
    // Full takeover: the original message view is replaced while composing.
    expect(screen.queryByTestId('email-renderer')).not.toBeInTheDocument();
    // Session is live in the store.
    expect(useInlineComposerStore.getState().session?.intent).toBe('reply');
  });

  it('clicking Forward docks the composer with a Fwd: subject', async () => {
    render(<ReadingPane />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^forward$/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^forward$/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Fwd: Q2 IT Infrastructure Upgrade')).toBeInTheDocument();
    });
    expect(useInlineComposerStore.getState().session?.intent).toBe('forward');
  });

  it('send through the dock calls sendEmail and closes the session', async () => {
    mockSendEmail.mockResolvedValue({ success: true });
    render(<ReadingPane />);
    fireEvent.click(await screen.findByRole('button', { name: /^reply$/i }));
    await waitFor(() => expect(screen.getByTitle('david@example.com')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalled());
    await waitFor(() => expect(useInlineComposerStore.getState().session).toBeNull());
  });
});
