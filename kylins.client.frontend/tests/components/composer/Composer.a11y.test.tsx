import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  useAccountStore.setState({
    accounts: [{ id: 'acc-1', email: 'a@example.com', displayName: 'A', provider: 'imap' }],
    activeAccountId: 'acc-1',
  });
  usePreferencesStore.setState({ enableRichText: false, alwaysShowCcBcc: false });
});

describe('Composer accessibility', () => {
  it('gives icon-only buttons accessible names', () => {
    render(<Composer />);
    expect(screen.getByRole('button', { name: /close composer/i })).toBeInTheDocument();
  });

  it('marks the send button with a clear role and label', () => {
    render(<Composer />);
    const send = screen.getByRole('button', { name: /send/i });
    expect(send).toBeInTheDocument();
  });
});
