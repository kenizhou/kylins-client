import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Composer } from '../../../src/components/composer/Composer';
import { useComposerStore } from '../../../src/stores/composerStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn(() => ({})) }));

vi.mock('../../../src/services/db/signatures', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/db/signatures')>();
  return {
    ...actual,
    getDefaultSignature: vi.fn(() => Promise.resolve(null)),
    getSignaturesForAccount: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('../../../src/services/db/sendAsAliases', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/db/sendAsAliases')>();
  return {
    ...actual,
    getAliasesForAccount: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('../../../src/services/db/templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/db/templates')>();
  return {
    ...actual,
    getTemplatesForAccount: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('../../../src/services/composer/draftAutoSave', () => ({
  startAutoSave: vi.fn(() => () => {}),
  stopAutoSave: vi.fn(),
}));

vi.mock('../../../src/services/composer/send', () => ({
  sendEmail: vi.fn(() => Promise.resolve({ success: true })),
}));

function setupAccount() {
  useAccountStore.setState({
    accounts: [{ id: 'acc-1', email: 'a@example.com', displayName: 'A User', provider: 'imap' }],
    activeAccountId: 'acc-1',
  });
}

beforeEach(() => {
  useComposerStore.setState({
    isOpen: true,
    mode: 'new',
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: '',
    bodyHtml: '',
    attachments: [],
  });
  usePreferencesStore.setState({ enableRichText: false, alwaysShowCcBcc: false });
  setupAccount();
});

describe('Composer default view', () => {
  it('shows To, Subject and Send by default and hides Cc/Bcc/Reply-To', () => {
    render(<Composer />);
    expect(screen.getByLabelText(/^to$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^subject$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^cc$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^bcc$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^reply-to$/i)).not.toBeInTheDocument();
  });

  it('reveals Cc/Bcc/Reply-To when the Cc link is clicked', () => {
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: /cc/i }));
    expect(screen.getByLabelText(/^cc$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^bcc$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^reply-to$/i)).toBeInTheDocument();
  });

  it('auto-expands Cc when a Cc value is present on open', async () => {
    useComposerStore.setState({ cc: [{ name: '', email: 'cc@example.com' }] });
    render(<Composer />);
    await waitFor(() => expect(screen.getByLabelText(/^cc$/i)).toBeInTheDocument());
  });
});
