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
import { useDraftIndexStore } from '../../../src/stores/draftIndexStore';
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
    useDraftIndexStore.setState({ accountId: null, threadIds: new Set() });
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

  it('resumes a persisted inline draft on message select (app-reload path)', async () => {
    // Post-restart state: no inline session, but local_drafts has a row for
    // this conversation and the draft index already knows the thread.
    const draftRow = {
      id: 'row-1',
      account_id: 'acc-1',
      to_addresses: JSON.stringify(['David <david@example.com>']),
      cc_addresses: null,
      bcc_addresses: null,
      subject: 'Re: Q2 IT Infrastructure Upgrade',
      body_html: '<p>typed before restart</p>',
      reply_to_message_id: '<mid-1@example.com>',
      thread_id: 't1',
      from_email: 'me@example.com',
      signature_id: null,
      remote_draft_id: null,
      attachments: null,
      classification_id: null,
      is_encrypted: 0,
      is_signed: 0,
      importance: 'normal',
      request_read_receipt: 0,
      deliver_at: null,
      prevent_copy: 0,
      extra_headers: null,
      created_at: 100,
      updated_at: 200,
      sync_status: 'local',
    };
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_list_drafts_for_account') return [draftRow];
      if (cmd === 'db_get_aliases_for_account') return [];
      if (cmd === 'db_get_signatures_for_account') return [];
      if (cmd === 'db_get_default_signature') return null;
      return undefined;
    });
    useDraftIndexStore.setState({ accountId: 'acc-1', threadIds: new Set(['t1']) });

    render(<ReadingPane />);

    // The dock takes over with the saved content — no Reply click needed.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(document.querySelector('.kylins-editor')?.innerHTML).toContain('typed before restart'),
    );
    expect(screen.getByDisplayValue('Re: Q2 IT Infrastructure Upgrade')).toBeInTheDocument();
    const s = useInlineComposerStore.getState().session!;
    expect(s.draftId).toBe('row-1');
    expect(s.pristine).toBe(true);
    expect(s.intent).toBe('reply');
    expect(s.to).toEqual([{ name: 'David', email: 'david@example.com' }]);
  });

  it('replaces a retained session with the selected message’s OWN draft (outgoing preserved)', async () => {
    const draftRow = {
      id: 'row-1',
      account_id: 'acc-1',
      to_addresses: JSON.stringify(['David <david@example.com>']),
      cc_addresses: null,
      bcc_addresses: null,
      subject: 'Re: Q2 IT Infrastructure Upgrade',
      body_html: '<p>typed before restart</p>',
      reply_to_message_id: '<mid-1@example.com>',
      thread_id: 't1',
      from_email: 'me@example.com',
      signature_id: null,
      remote_draft_id: null,
      attachments: null,
      classification_id: null,
      is_encrypted: 0,
      is_signed: 0,
      importance: 'normal',
      request_read_receipt: 0,
      deliver_at: null,
      prevent_copy: 0,
      extra_headers: null,
      created_at: 100,
      updated_at: 200,
      sync_status: 'local',
    };
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_list_drafts_for_account') return [draftRow];
      if (cmd === 'db_get_aliases_for_account') return [];
      if (cmd === 'db_get_signatures_for_account') return [];
      if (cmd === 'db_get_default_signature') return null;
      return undefined;
    });
    useDraftIndexStore.setState({ accountId: 'acc-1', threadIds: new Set(['t1']) });
    // A retained session for ANOTHER message is live…
    useInlineComposerStore.setState({
      session: {
        stagingDraftId: 'other-stage',
        draftId: 'row-elsewhere',
        anchor: {
          kind: 'reply',
          message: { id: 'msg-elsewhere', subject: 'Elsewhere', threadId: 't-other' },
        },
      } as never,
    });

    render(<ReadingPane />);

    // …but this message has its OWN saved draft: it wins (the retained
    // session is preserved, not deleted), and the dock takes over.
    await waitFor(() => expect(useInlineComposerStore.getState().session?.draftId).toBe('row-1'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument(),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith('db_delete_draft', { id: 'row-elsewhere' });
  });

  it('restores the LATEST draft version for a thread with multiple drafts', async () => {
    const mk = (id: string, updatedAt: number, body: string) => ({
      id,
      account_id: 'acc-1',
      to_addresses: null,
      cc_addresses: null,
      bcc_addresses: null,
      subject: 'Re: Q2 IT Infrastructure Upgrade',
      body_html: body,
      reply_to_message_id: '<mid-1@example.com>',
      thread_id: 't1',
      from_email: 'me@example.com',
      signature_id: null,
      remote_draft_id: null,
      attachments: null,
      classification_id: null,
      is_encrypted: 0,
      is_signed: 0,
      importance: 'normal',
      request_read_receipt: 0,
      deliver_at: null,
      prevent_copy: 0,
      extra_headers: null,
      created_at: 100,
      updated_at: updatedAt,
      sync_status: 'local',
    });
    // Backend returns updated_at DESC: newest first.
    const rows = [mk('row-latest', 300, '<p>456</p>'), mk('row-older', 200, '<p>123</p>')];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_list_drafts_for_account') return rows;
      if (cmd === 'db_get_aliases_for_account') return [];
      if (cmd === 'db_get_signatures_for_account') return [];
      if (cmd === 'db_get_default_signature') return null;
      return undefined;
    });
    useDraftIndexStore.setState({ accountId: 'acc-1', threadIds: new Set(['t1']) });

    render(<ReadingPane />);

    await waitFor(() =>
      expect(useInlineComposerStore.getState().session?.draftId).toBe('row-latest'),
    );
    await waitFor(() =>
      expect(document.querySelector('.kylins-editor')?.innerHTML).toContain('456'),
    );
  });

  it('a message WITHOUT a saved draft keeps the retained session hidden (no restore)', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'db_list_drafts_for_account') return [];
      if (cmd === 'db_get_aliases_for_account') return [];
      if (cmd === 'db_get_signatures_for_account') return [];
      if (cmd === 'db_get_default_signature') return null;
      return undefined;
    });
    // Index has no thread for this message.
    useDraftIndexStore.setState({ accountId: 'acc-1', threadIds: new Set() });
    useInlineComposerStore.setState({
      session: {
        stagingDraftId: 'other-stage',
        draftId: 'row-elsewhere',
        anchor: {
          kind: 'reply',
          message: { id: 'msg-elsewhere', subject: 'Elsewhere', threadId: 't-other' },
        },
      } as never,
    });

    render(<ReadingPane />);
    await waitFor(() =>
      expect(screen.getByText('Q2 IT Infrastructure Upgrade')).toBeInTheDocument(),
    );
    // Give the restore effect a chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(useInlineComposerStore.getState().session?.stagingDraftId).toBe('other-stage');
    expect(screen.queryByRole('button', { name: /^send$/i })).not.toBeInTheDocument();
  });

  it('shows the dock for a standalone (new-message) draft with no message selected', async () => {
    const row = {
      id: 'row-new',
      account_id: 'acc-1',
      to_addresses: JSON.stringify(['Bob <bob@example.com>']),
      cc_addresses: null,
      bcc_addresses: null,
      reply_to_addresses: null,
      subject: 'Brand new message',
      body_html: '<p>brand new body</p>',
      reply_to_message_id: null,
      thread_id: null,
      from_email: 'me@example.com',
      signature_id: null,
      remote_draft_id: null,
      attachments: null,
      classification_id: null,
      is_encrypted: 0,
      is_signed: 0,
      importance: 'normal',
      request_read_receipt: 0,
      request_delivery_receipt: 0,
      deliver_at: null,
      prevent_copy: 0,
      extra_headers: null,
      created_at: 100,
      updated_at: 200,
      sync_status: 'local',
    } as never;
    useInlineComposerStore
      .getState()
      .resumeDraft(row, { id: 'acc-1', email: 'me@example.com', displayName: 'Me' });
    // No selected message — the draft row is the reading-pane target.
    useViewStore.setState({ selectedMessage: null, selectedDraftId: 'row-new' });

    render(<ReadingPane />);

    // Takeover fires even with selectedMessage null (dock-first precedence).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(document.querySelector('.kylins-editor')?.innerHTML).toContain('brand new body'),
    );
    expect(screen.getByDisplayValue('Brand new message')).toBeInTheDocument();
    expect(screen.queryByText('No message selected')).not.toBeInTheDocument();
    expect(useInlineComposerStore.getState().session?.anchor.kind).toBe('standalone');
  });

  it('hides the standalone dock when a different draft row is selected', async () => {
    const row = {
      id: 'row-new',
      account_id: 'acc-1',
      to_addresses: null,
      cc_addresses: null,
      bcc_addresses: null,
      reply_to_addresses: null,
      subject: 'Brand new message',
      body_html: '<p>brand new body</p>',
      reply_to_message_id: null,
      thread_id: null,
      from_email: 'me@example.com',
      signature_id: null,
      remote_draft_id: null,
      attachments: null,
      classification_id: null,
      is_encrypted: 0,
      is_signed: 0,
      importance: 'normal',
      request_read_receipt: 0,
      request_delivery_receipt: 0,
      deliver_at: null,
      prevent_copy: 0,
      extra_headers: null,
      created_at: 100,
      updated_at: 200,
      sync_status: 'local',
    } as never;
    useInlineComposerStore
      .getState()
      .resumeDraft(row, { id: 'acc-1', email: 'me@example.com', displayName: 'Me' });
    useViewStore.setState({ selectedMessage: null, selectedDraftId: 'row-other' });

    render(<ReadingPane />);

    // Session exists but is anchored to another draft row: no takeover.
    await waitFor(() => expect(screen.getByText('No message selected')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^send$/i })).not.toBeInTheDocument();
  });
});
