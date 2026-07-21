import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Composer } from '../../../src/components/composer/Composer';
import { useComposerStore } from '../../../src/stores/composerStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const setTitle = vi.fn(() => Promise.resolve());
const windowClose = vi.fn(() => Promise.resolve());
let closeRequestedHandler: ((event: { preventDefault: () => void }) => void) | null = null;

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    setTitle,
    close: windowClose,
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    onCloseRequested: vi.fn((cb: (event: { preventDefault: () => void }) => void) => {
      closeRequestedHandler = cb;
      return Promise.resolve(() => {
        closeRequestedHandler = null;
      });
    }),
  })),
}));

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
  flushDraftSave: vi.fn(() => Promise.resolve()),
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
  setTitle.mockClear();
  windowClose.mockClear();
  closeRequestedHandler = null;
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

describe('Composer windowed (pop-out)', () => {
  it('renders the glass titlebar with the subject, the actions row, and the status bar', () => {
    useComposerStore.setState({ subject: 'Quarterly report' });
    render(<Composer windowed />);
    expect(screen.getByTestId('composer-title-bar-drag-region')).toBeInTheDocument();
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
    expect(setTitle).toHaveBeenCalledWith('Quarterly report');
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByText(/words · /)).toBeInTheDocument();
  });

  it('falls back to the mode label when the subject is empty', () => {
    render(<Composer windowed />);
    expect(screen.getByText('New Message')).toBeInTheDocument();
    expect(setTitle).toHaveBeenCalledWith('New Message');
  });

  it('does not render the inline footer (no footer landmark when inline, status bar when windowed)', () => {
    const { unmount } = render(<Composer />);
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
    unmount();
    render(<Composer windowed />);
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('lets an untouched empty compose close without prompting', async () => {
    render(<Composer windowed />);
    expect(closeRequestedHandler).not.toBeNull();
    const event = { preventDefault: vi.fn() };
    await closeRequestedHandler!(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByText('Save this draft?')).not.toBeInTheDocument();
  });

  it('intercepts close with unsaved content and shows the confirm dialog', async () => {
    useComposerStore.setState({ subject: 'Unsaved work' });
    render(<Composer windowed />);
    const event = { preventDefault: vi.fn() };
    await closeRequestedHandler!(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(screen.getByText('Save this draft?')).toBeInTheDocument();

    // Cancel dismisses without closing.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Save this draft?')).not.toBeInTheDocument();
    expect(windowClose).not.toHaveBeenCalled();
  });

  it("Don't Save discards and closes the window", async () => {
    useComposerStore.setState({ subject: 'Unsaved work' });
    render(<Composer windowed />);
    await closeRequestedHandler!({ preventDefault: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: "Don't Save" }));
    await waitFor(() => expect(windowClose).toHaveBeenCalled());
  });

  it('Save Draft flushes the draft and closes the window', async () => {
    const { flushDraftSave } = await import('../../../src/services/composer/draftAutoSave');
    useComposerStore.setState({ subject: 'Unsaved work' });
    render(<Composer windowed />);
    await closeRequestedHandler!({ preventDefault: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));
    await waitFor(() => expect(flushDraftSave).toHaveBeenCalled());
    await waitFor(() => expect(windowClose).toHaveBeenCalled());
  });
});
