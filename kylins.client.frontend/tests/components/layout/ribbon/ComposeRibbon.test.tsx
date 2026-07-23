import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// Configurable ribbon width for the scaling tests.
let ribbonWidth = 1200;
vi.mock('../../../../src/hooks/useElementWidth', () => ({
  useElementWidth: () => ({ ref: { current: null }, width: ribbonWidth }),
}));

import { ComposeRibbon } from '../../../../src/components/layout/ribbon/ComposeRibbon';
import { useComposerStore } from '../../../../src/stores/composerStore';
import {
  useInlineComposerStore,
  type InlineSession,
} from '../../../../src/stores/inlineComposerStore';
import { useViewStore } from '../../../../src/features/view/viewStore';
import type { MailMessage } from '../../../../src/features/view/viewStore';

const ribbonMessage: MailMessage = {
  id: 'msg-1',
  subject: 'Hi',
  from: { name: 'Bob', address: 'bob@example.com' },
  to: [{ name: 'Me', address: 'me@example.com' }],
  date: new Date().toISOString(),
  preview: '',
  html: '<p>x</p>',
  text: 'x',
  classificationId: null,
  isEncrypted: false,
  isSigned: false,
};

function inlineSession(): InlineSession {
  return {
    messageId: 'msg-1',
    message: ribbonMessage,
    accountId: 'acc-1',
    accountEmail: 'me@example.com',
    intent: 'reply',
    seed: null,
    seedError: null,
    stagingDraftId: 'draft-1',
    pristine: true,
    bodyHtml: null,
    signatureId: undefined,
    classificationId: null,
    fromEmail: 'me@example.com',
    selfEmails: ['me@example.com'],
    includeOriginalAttachments: false,
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 'Re: Hi',
    attachments: [],
    importance: 'normal',
    requestReadReceipt: false,
    requestDeliveryReceipt: false,
    deliverAt: null,
    preventCopy: false,
    isEncrypted: false,
    isSigned: false,
  };
}

beforeEach(() => {
  ribbonWidth = 1200;
  useViewStore.setState({ selectedMessage: null });
  useInlineComposerStore.setState({ session: null });
  useComposerStore.setState({
    importance: 'normal',
    isEncrypted: false,
    isSigned: false,
    preventCopy: false,
    requestReadReceipt: false,
    requestDeliveryReceipt: false,
    deliverAt: null,
  });
});

describe('ComposeRibbon', () => {
  it('shows every ribbon item with an icon and no Link button', () => {
    const { container } = render(<ComposeRibbon />);
    // Link removed; insert-link lives in the editor toolbar / Ctrl+K.
    expect(screen.queryByRole('button', { name: /^link$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delay delivery/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /attach/i })).toBeInTheDocument();

    // Every labeled ribbon item renders a leading svg icon.
    for (const name of ['Delay Delivery', 'Attach', 'Importance', 'Tracking']) {
      const btn = screen.getByRole('button', { name: new RegExp(name, 'i') });
      expect(btn.querySelector('svg')).not.toBeNull();
    }
    // Toggle icons unified at 17px.
    const encrypt = screen.getByRole('checkbox', { name: /encrypt/i });
    const wrapper = encrypt.closest('label') ?? encrypt.parentElement!;
    expect(wrapper.querySelector('svg')?.getAttribute('width')).toBe('17');
    void container;
  });

  it('collapses labels to icons below 900px', () => {
    ribbonWidth = 800;
    render(<ComposeRibbon />);
    // Accessible names remain (aria-label), visible label text is gone.
    const attach = screen.getByRole('button', { name: /attach/i });
    expect(attach.textContent).not.toContain('Attach');
    // Importance trigger keeps its icon and caret but hides the text.
    const importance = screen.getByRole('button', { name: /importance/i });
    expect(importance.textContent).not.toContain('Importance');
    expect(importance.querySelector('svg')).not.toBeNull();
  });

  it('collapses secondary groups into a More overflow menu below 640px', () => {
    ribbonWidth = 500;
    render(<ComposeRibbon />);
    expect(screen.queryByRole('checkbox', { name: /encrypt/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /importance/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tracking/i })).not.toBeInTheDocument();
    // Primary actions stay visible.
    expect(screen.getByRole('button', { name: /delay delivery/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /attach/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    expect(screen.getByRole('menuitemradio', { name: /high/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /read receipt/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /encrypt/i })).toBeInTheDocument();
  });

  it('overflow menu actions update composer state', () => {
    ribbonWidth = 500;
    render(<ComposeRibbon />);
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^high$/i }));
    expect(useComposerStore.getState().importance).toBe('high');
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /encrypt/i }));
    expect(useComposerStore.getState().isEncrypted).toBe(true);
  });
});

describe('ComposeRibbon with the inline composer docked', () => {
  beforeEach(() => {
    ribbonWidth = 1200;
    useViewStore.setState({ selectedMessage: ribbonMessage });
    useInlineComposerStore.setState({ session: inlineSession() });
  });

  it('routes toggles to the inline session, NOT the modal store', () => {
    render(<ComposeRibbon />);
    fireEvent.click(screen.getByRole('checkbox', { name: /encrypt/i }));
    expect(useInlineComposerStore.getState().session?.isEncrypted).toBe(true);
    expect(useComposerStore.getState().isEncrypted).toBe(false);
  });

  it('routes importance to the inline session', () => {
    render(<ComposeRibbon />);
    fireEvent.click(screen.getByRole('button', { name: /importance/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^high$/i }));
    expect(useInlineComposerStore.getState().session?.importance).toBe('high');
    expect(useComposerStore.getState().importance).toBe('normal');
  });

  it('hides Delay Delivery (unsupported by the inline surface)', () => {
    render(<ComposeRibbon />);
    expect(screen.queryByRole('button', { name: /delay delivery/i })).not.toBeInTheDocument();
    // Attach stays — it is genuinely wired to the inline composer.
    expect(screen.getByRole('button', { name: /attach/i })).toBeInTheDocument();
  });

  it('a retained (hidden) session does NOT capture the ribbon', () => {
    // Session belongs to another message → dock not visible → modal target.
    useInlineComposerStore.setState({
      session: { ...inlineSession(), messageId: 'msg-other' },
    });
    render(<ComposeRibbon />);
    fireEvent.click(screen.getByRole('checkbox', { name: /encrypt/i }));
    expect(useComposerStore.getState().isEncrypted).toBe(true);
    expect(useInlineComposerStore.getState().session?.isEncrypted).toBe(false);
  });
});
