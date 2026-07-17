import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act, screen } from '@testing-library/react';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { ReadingPane } from '../../../src/components/layout/ReadingPane';
import { useViewStore } from '../../../src/features/view/viewStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import { useClassificationStore } from '../../../src/features/classification/classificationStore';
import { getAttachments, fetchAttachment } from '../../../src/services/db/attachments';
import type { MailMessage } from '../../../src/features/view/viewStore';

vi.mock('../../../src/components/plugins/InjectedComponentSet', () => ({
  InjectedComponentSet: () => null,
}));

vi.mock('../../../src/components/email/EmailRenderer', () => ({
  // Render a marker that also surfaces the html prop so the decrypt-ok test
  // can assert the decrypted plaintext reaches the renderer.
  EmailRenderer: ({ html }: { html?: string | null }) => (
    <div data-testid="email-renderer" data-html={html ?? ''} />
  ),
}));

vi.mock('../../../src/components/email/InlineReply', () => ({
  InlineReply: () => <div data-testid="inline-reply" />,
}));

vi.mock('../../../src/features/viewer/RsvpCard', () => ({
  RsvpCard: ({ event }: { event: { summary?: string } }) => (
    <div data-testid="rsvp-card">{event.summary ?? 'Meeting request'}</div>
  ),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
}));

vi.mock('../../../src/services/db/attachments', () => ({
  getAttachments: vi.fn(),
  fetchAttachment: vi.fn(),
  fetchInlineImages: () => Promise.resolve([]),
  referencedCids: () => new Set<string>(),
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
    vi.mocked(getAttachments).mockReset().mockResolvedValue([]);
    vi.mocked(fetchAttachment).mockReset();
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

  it('renders an RSVP card for calendar-invite attachments', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'METHOD:REQUEST',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:invite-123',
      'SUMMARY:Project Kickoff',
      'DTSTART:20260710T150000Z',
      'DTEND:20260710T160000Z',
      'ORGANIZER:mailto:organizer@example.com',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    vi.mocked(getAttachments).mockResolvedValue([
      {
        id: 'att-1',
        accountId: 'acc-1',
        messageId: 'msg-1',
        filename: 'invite.ics',
        mimeType: 'text/calendar; method=REQUEST',
        size: ics.length,
        isInline: false,
      },
    ]);
    vi.mocked(fetchAttachment).mockResolvedValue({
      filePath: '/appdata/attachment-cache/acc-1/ms/msg-1/invite.ics',
      filename: 'invite.ics',
      mimeType: 'text/calendar; method=REQUEST',
      size: ics.length,
    });
    vi.mocked(readTextFile).mockResolvedValue(ics);

    render(<ReadingPane />);
    act(() => {
      useViewStore.setState({ selectedMessage: message });
    });

    await waitFor(() => {
      expect(screen.getByTestId('rsvp-card')).toHaveTextContent('Project Kickoff');
    });
  });

  // ── G6 Task 4: crypto-badge hoist + decrypt-failure panel ──────────────
  //
  // Three scenarios covering the new behavior:
  //   (a) a decrypted S/MIME message (no classification) → the granular
  //       CryptoBadge renders ABOVE the body (hoisted past the level gate),
  //       and EmailRenderer still renders the decrypted plaintext html.
  //   (b) a no-key message → the centered decrypt-failure panel renders
  //       ("no matching private key") + a "Manage keys" action, and the
  //       EmailRenderer does NOT render.
  //   (c) a plain (non-crypto) message → no CryptoBadge (no regression), the
  //       EmailRenderer renders the body as before.

  it('renders the granular CryptoBadge + EmailRenderer for a decrypted message without classification', async () => {
    const decrypted: MailMessage = {
      ...message,
      id: 'msg-decrypted',
      isEncrypted: true,
      isSigned: true,
      signatureState: 'valid-verified',
      decryptState: 'ok',
      revocationState: 'good',
      signerEmail: 'signer@example.com',
      signerFingerprint: 'ab:cd:ef:01:02:03',
      html: '<p>Decrypted body</p>',
      // classificationId intentionally null → tests the hoist past `level`
      classificationId: null,
    };

    render(<ReadingPane />);
    act(() => {
      useViewStore.setState({ selectedMessage: decrypted });
    });

    await waitFor(() => {
      // Granular CryptoBadge is hoisted out of the classification gate.
      const badge = screen.getByTestId('crypto-badge');
      expect(badge).toBeInTheDocument();
      // Combined aria-label includes both the decrypt-ok and the verified-
      // signature clauses (see CryptoBadge.tsx segment assembly).
      expect(badge).toHaveAttribute('aria-label');
      const label = badge.getAttribute('aria-label') ?? '';
      expect(label).toMatch(/decrypted/i);
      expect(label).toMatch(/verified/i);
      // EmailRenderer still renders + receives the decrypted plaintext.
      const renderer = screen.getByTestId('email-renderer');
      expect(renderer).toHaveAttribute('data-html', '<p>Decrypted body</p>');
    });
  });

  it('renders the decrypt-failure panel and hides the EmailRenderer when decryptState is no-key', async () => {
    const noKey: MailMessage = {
      ...message,
      id: 'msg-no-key',
      isEncrypted: true,
      isSigned: false,
      decryptState: 'no-key',
      classificationId: null,
      html: '<p>Should not render</p>',
    };

    render(<ReadingPane />);
    act(() => {
      useViewStore.setState({ selectedMessage: noKey });
    });

    await waitFor(() => {
      expect(screen.getByTestId('decrypt-failure-panel')).toBeInTheDocument();
      // Copy distinguishes no-key from generic failure.
      expect(screen.getByText(/no matching private key/i)).toBeInTheDocument();
      // Manage-keys action opens the Security preferences tab.
      expect(screen.getByRole('button', { name: /manage keys/i })).toBeInTheDocument();
      // Body renderer is gated off on decrypt failure.
      expect(screen.queryByTestId('email-renderer')).not.toBeInTheDocument();
    });
  });

  it('renders the decrypt-failure panel for decryptState=failed with a distinct copy', async () => {
    const failed: MailMessage = {
      ...message,
      id: 'msg-failed',
      isEncrypted: true,
      decryptState: 'failed',
      classificationId: null,
      html: '<p>Should not render</p>',
    };

    render(<ReadingPane />);
    act(() => {
      useViewStore.setState({ selectedMessage: failed });
    });

    await waitFor(() => {
      const panel = screen.getByTestId('decrypt-failure-panel');
      expect(panel).toBeInTheDocument();
      // Scope to the panel: the CryptoBadge in the row above also contains
      // "Decryption failed" (its label for the failed decrypt segment), so
      // a global getByText would match both. Both rendering is correct UX
      // (compact badge + detailed panel); the assertion just needs scoping.
      expect(panel).toHaveTextContent(/decryption failed/i);
      expect(panel).toHaveTextContent(/could not decrypt/i);
      expect(screen.queryByTestId('email-renderer')).not.toBeInTheDocument();
    });
  });

  it('does NOT render the granular CryptoBadge for a plain non-crypto message', async () => {
    render(<ReadingPane />);
    act(() => {
      useViewStore.setState({ selectedMessage: message });
    });

    await waitFor(() => {
      expect(screen.getByTestId('email-renderer')).toBeInTheDocument();
      expect(screen.queryByTestId('crypto-badge')).not.toBeInTheDocument();
      expect(screen.queryByTestId('decrypt-failure-panel')).not.toBeInTheDocument();
    });
  });
});
