// Component tests for the docked InlineReply: skeleton while the seed
// resolves, store-driven rendering once seeded, attachment chips, the forward
// include-originals checkbox, and the send path (full option set →
// clearAfterSend).

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
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));

const { mockSendEmail } = vi.hoisted(() => ({ mockSendEmail: vi.fn() }));
vi.mock('../../../src/services/composer/send', () => ({ sendEmail: mockSendEmail }));

vi.mock('../../../src/services/db/attachments', () => ({
  getAttachments: vi.fn(async () => []),
  fetchAttachment: vi.fn(),
  fetchInlineImages: vi.fn(async () => []),
  cachedImageToDataUrl: vi.fn(async () => 'data:'),
}));

import { InlineReply } from '../../../src/components/email/InlineReply';
import { useInlineComposerStore } from '../../../src/stores/inlineComposerStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import type { InlineIntent } from '../../../src/features/composer/draftFactory';
import type { MailMessage } from '../../../src/features/view/viewStore';

const account = { id: 'acc-1', email: 'me@example.com', displayName: 'Me' };

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'msg-1',
    subject: 'Hello',
    from: { name: 'Bob', address: 'bob@example.com' },
    to: [{ name: 'Me', address: 'me@example.com' }],
    cc: [{ name: 'Carol', address: 'carol@example.com' }],
    replyTo: [],
    date: new Date('2026-07-05T10:00:00Z').toISOString(),
    preview: 'preview',
    html: '<p>Original body</p>',
    text: 'Original body',
    threadId: 't1',
    messageId: '<mid-1@example.com>',
    classificationId: null,
    isEncrypted: false,
    isSigned: false,
    ...overrides,
  };
}

async function openSession(intent: InlineIntent, message = makeMessage()) {
  useInlineComposerStore.getState().open(intent, message, account);
  await waitFor(() => expect(useInlineComposerStore.getState().session?.seed).not.toBeNull());
}

describe('InlineReply', () => {
  beforeEach(() => {
    useInlineComposerStore.setState({ session: null });
    usePreferencesStore.setState({ quoteStyle: 'outlook', alwaysShowCcBcc: false });
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_aliases_for_account') return [];
      if (cmd === 'db_get_signatures_for_account') return [];
      if (cmd === 'db_get_default_signature') return null;
      return undefined;
    });
    mockSendEmail.mockReset();
  });

  it('renders nothing without a session', () => {
    const { container } = render(<InlineReply />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a skeleton while the seed resolves', () => {
    // Session with no seed (pre-resolution state).
    useInlineComposerStore.setState({
      session: {
        ...useInlineComposerStore.getState().session,
        messageId: 'msg-1',
        message: makeMessage(),
        accountId: 'acc-1',
        accountEmail: 'me@example.com',
        intent: 'reply',
        seed: null,
        seedError: null,
        stagingDraftId: 'draft-x',
        pristine: true,
        bodyHtml: null,
        signatureId: undefined,
        classificationId: null,
        fromEmail: null,
        selfEmails: ['me@example.com'],
        includeOriginalAttachments: false,
        to: [],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: '',
        attachments: [],
        importance: 'normal',
        requestReadReceipt: false,
        requestDeliveryReceipt: false,
        deliverAt: null,
        preventCopy: false,
        isEncrypted: false,
        isSigned: false,
      },
    });
    render(<InlineReply />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
  });

  it('renders the seeded reply: actions on top, recipients, subject, outlook quote', async () => {
    await openSession('reply');
    render(<InlineReply />);
    await waitFor(() => expect(screen.getByTitle('bob@example.com')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Re: Hello')).toBeInTheDocument();
    // Actions live in the top bar.
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pop out/i })).toBeInTheDocument();
    // Outlook quote: header block + marked separator, unindented.
    const editorEl = document.querySelector('.kylins-editor');
    expect(editorEl?.innerHTML).toContain('From:');
    expect(editorEl?.innerHTML).toContain('data-quote="original"');
    expect(editorEl?.innerHTML).not.toContain('gmail_quote');
  });

  it('Cc toggle in the To row expands the Cc field (modal-composer style)', async () => {
    await openSession('reply');
    render(<InlineReply />);
    await waitFor(() => expect(screen.getByTitle('bob@example.com')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText('Cc recipients')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show cc field/i }));
    expect(screen.getByPlaceholderText('Cc recipients')).toBeInTheDocument();
  });

  it('attachment chips are individually removable (seeded or picked)', async () => {
    await openSession('replyWithAttachments');
    useInlineComposerStore.getState().addAttachment({
      id: 'a1',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      size: 12,
      filePath: '/outbox/notes.txt',
      origin: 'picked',
    });
    render(<InlineReply />);
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /remove notes\.txt/i }));
    expect(useInlineComposerStore.getState().session?.attachments).toHaveLength(0);
  });

  it('shows the include-original-attachments checkbox for forwards only', async () => {
    await openSession('forward');
    const { unmount } = render(<InlineReply />);
    await waitFor(() =>
      expect(screen.getByText(/include original attachments/i)).toBeInTheDocument(),
    );
    unmount();

    useInlineComposerStore.setState({ session: null });
    await openSession('reply');
    render(<InlineReply />);
    await waitFor(() => expect(screen.getByTitle('bob@example.com')).toBeInTheDocument());
    expect(screen.queryByText(/include original attachments/i)).not.toBeInTheDocument();
  });

  it('send passes the full option set and clears the session on success', async () => {
    await openSession('reply');
    useInlineComposerStore.getState().setImportance('high');
    useInlineComposerStore.getState().setRequestReadReceipt(true);
    const expectedStagingId = useInlineComposerStore.getState().session!.stagingDraftId;
    mockSendEmail.mockResolvedValue({ success: true });

    render(<InlineReply />);
    await waitFor(() => expect(screen.getByTitle('bob@example.com')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(mockSendEmail).toHaveBeenCalled());
    const [accountId, input, stagingId] = mockSendEmail.mock.calls[0]!;
    expect(accountId).toBe('acc-1');
    expect(input).toMatchObject({
      importance: 'high',
      requestReadReceipt: true,
      subject: 'Re: Hello',
      inReplyToMessageId: '<mid-1@example.com>',
    });
    expect(stagingId).toBe(expectedStagingId);
    await waitFor(() => expect(useInlineComposerStore.getState().session).toBeNull());
  });

  it('send failure keeps the session and shows the error', async () => {
    await openSession('reply');
    mockSendEmail.mockResolvedValue({ success: false, message: 'SMTP refused' });
    render(<InlineReply />);
    await waitFor(() => expect(screen.getByTitle('bob@example.com')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText('SMTP refused')).toBeInTheDocument());
    expect(useInlineComposerStore.getState().session).not.toBeNull();
  });
});
