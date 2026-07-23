import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReadRibbon } from '../../../../src/components/layout/ribbon/ReadRibbon';
import { useViewStore } from '../../../../src/features/view/viewStore';
import { useThreadStore } from '../../../../src/stores/threadStore';
import { useAccountStore } from '../../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../../src/stores/preferencesStore';
import { useInlineComposerStore } from '../../../../src/stores/inlineComposerStore';
import type { Thread } from '../../../../src/services/db/threads';
import type { MailMessage } from '../../../../src/features/view/viewStore';

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
}));

vi.mock('../../../../src/services/db/attachments', () => ({
  getAttachments: vi.fn(async () => []),
  fetchAttachment: vi.fn(),
  fetchInlineImages: vi.fn(async () => []),
  cachedImageToDataUrl: vi.fn(async () => 'data:'),
}));

const { mockOpenReplyWithAttachments } = vi.hoisted(() => ({
  mockOpenReplyWithAttachments: vi.fn(),
}));
vi.mock('../../../../src/utils/composerActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/utils/composerActions')>();
  return {
    ...actual,
    openReplyComposerWithAttachments: mockOpenReplyWithAttachments,
  };
});

let originalResizeObserver: typeof globalThis.ResizeObserver;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;

function setRibbonWidth(width: number) {
  const rect = {
    width,
    height: 100,
    top: 0,
    left: 0,
    bottom: 100,
    right: width,
    x: 0,
    y: 0,
    toJSON: () => {},
  } as unknown as DOMRect;
  Element.prototype.getBoundingClientRect = vi.fn(() => rect);
  globalThis.ResizeObserver = class ResizeObserverMock {
    constructor(private callback: ResizeObserverCallback) {}
    observe(el: Element) {
      this.callback(
        [{ target: el, contentRect: { width, height: 100 } as DOMRectReadOnly }],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

  useViewStore.setState({ selectedMessage: null });
  useInlineComposerStore.setState({ session: null });
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'db_get_aliases_for_account') return [];
    return undefined;
  });
  useThreadStore.setState({ threads: [], selectedThreadId: null });
  useAccountStore.setState({ accounts: [], activeAccountId: null });
  usePreferencesStore.setState({ defaultReplyBehavior: 'reply' });

  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        width: 500,
        height: 100,
        top: 0,
        left: 0,
        bottom: 100,
        right: 500,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as unknown as DOMRect,
  );

  globalThis.ResizeObserver = class ResizeObserverMock {
    constructor(private callback: ResizeObserverCallback) {}
    observe(el: Element) {
      this.callback(
        [{ target: el, contentRect: { width: 500, height: 100 } as DOMRectReadOnly }],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  globalThis.ResizeObserver = originalResizeObserver;
});

describe('ReadRibbon', () => {
  it('renders New and Reply groups', async () => {
    render(<ReadRibbon />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new email/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reply$/i })).toBeInTheDocument();
    });
  });

  it('does not render a Pin button', async () => {
    render(<ReadRibbon />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^pin$/i })).not.toBeInTheDocument();
    });
  });

  it('archives the selected thread when Archive is clicked', async () => {
    const archiveThread = vi.spyOn(
      await import('../../../../src/services/mail/actions'),
      'archiveThread',
    );
    useThreadStore.setState({
      threads: [{ id: 't1', accountId: 'a1', subject: 'x', isRead: true } as never],
      selectedThreadId: 't1',
    });
    useAccountStore.setState({
      accounts: [{ id: 'a1', email: 'me@x.com' } as never],
      activeAccountId: 'a1',
    });
    setRibbonWidth(1024);
    render(<ReadRibbon />);
    fireEvent.click(screen.getByRole('button', { name: /archive/i }));
    expect(archiveThread).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    archiveThread.mockRestore();
  });

  it('disables the compact More button when no message or thread is selected', async () => {
    render(<ReadRibbon />);
    await waitFor(() => {
      const more = screen.getByRole('button', { name: /more actions/i });
      expect(more).toHaveAttribute('data-disabled', 'true');
    });
  });

  it('enables the compact More button when a thread is selected', async () => {
    const thread: Thread = {
      id: 't1',
      accountId: 'a1',
      subject: 'Test',
      snippet: null,
      lastMessageAt: null,
      messageCount: 1,
      isRead: true,
      isStarred: false,
      isImportant: false,
      hasAttachments: false,
      isSnoozed: false,
      fromName: null,
      fromAddress: null,
      classificationId: null,
      isEncrypted: false,
      isSigned: false,
    };
    useThreadStore.setState({ threads: [thread], selectedThreadId: 't1' });
    render(<ReadRibbon />);
    await waitFor(() => {
      const more = screen.getByRole('button', { name: /more actions/i });
      expect(more).not.toHaveAttribute('data-disabled');
    });
  });

  it('shows an overflow menu under 640px with archive/delete/move/mark unread/flag', async () => {
    setRibbonWidth(500);
    useThreadStore.setState({
      threads: [{ id: 't1', accountId: 'a1', subject: 'x', isRead: true } as never],
      selectedThreadId: 't1',
    });
    render(<ReadRibbon />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /archive/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /move/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /mark unread/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /flag/i })).toBeInTheDocument();
    });
  });

  it('collapses ribbon labels at 750px icon-only width without an overflow menu', async () => {
    setRibbonWidth(750);
    useThreadStore.setState({
      threads: [{ id: 't1', accountId: 'a1', subject: 'x', isRead: true } as never],
      selectedThreadId: 't1',
    });
    render(<ReadRibbon />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /reply$/i })).toBeInTheDocument();
    });
    // In icon-only mode the visible text labels are hidden (sr-only).
    expect(screen.getByText('Reply').classList.contains('sr-only')).toBe(true);
    expect(screen.getByText('Archive').classList.contains('sr-only')).toBe(true);
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
  });

  it('shows text labels at 1024px full width', async () => {
    setRibbonWidth(1024);
    useThreadStore.setState({
      threads: [{ id: 't1', accountId: 'a1', subject: 'x', isRead: true } as never],
      selectedThreadId: 't1',
    });
    render(<ReadRibbon />);
    await waitFor(() => {
      expect(screen.getByText('Reply')).toBeVisible();
      expect(screen.getByText('Archive')).toBeVisible();
      expect(screen.getByText('Delete')).toBeVisible();
    });
  });

  it('renders Mark Read and Flag icons at the same size as neighboring ribbon icons in icon-only mode', async () => {
    setRibbonWidth(750);
    useThreadStore.setState({
      threads: [
        { id: 't1', accountId: 'a1', subject: 'x', isRead: true, isStarred: true } as never,
      ],
      selectedThreadId: 't1',
    });
    render(<ReadRibbon />);

    await waitFor(() => {
      const markReadButton = screen.getByRole('button', { name: /mark as unread/i });
      const flagButton = screen.getByRole('button', { name: /remove flag/i });
      expect(markReadButton.querySelector('svg')).toHaveAttribute('width', '18');
      expect(markReadButton.querySelector('svg')).toHaveAttribute('height', '18');
      expect(flagButton.querySelector('svg')).toHaveAttribute('width', '18');
      expect(flagButton.querySelector('svg')).toHaveAttribute('height', '18');
    });
  });

  it('hides the split caret for Move and Mark Read in icon-only mode so the icon stays centered', async () => {
    setRibbonWidth(750);
    useThreadStore.setState({
      threads: [
        { id: 't1', accountId: 'a1', subject: 'x', isRead: true, isStarred: true } as never,
      ],
      selectedThreadId: 't1',
    });
    render(<ReadRibbon />);

    await waitFor(() => {
      const moveButton = screen.getByRole('button', { name: /move to folder/i });
      const markReadButton = screen.getByRole('button', { name: /mark as unread/i });
      // Each split button should contain only the action icon, not an extra caret.
      expect(moveButton.querySelectorAll('svg')).toHaveLength(1);
      expect(markReadButton.querySelectorAll('svg')).toHaveLength(1);
    });
  });

  it('shows the split caret for Move and Mark Read when labels are visible', async () => {
    setRibbonWidth(1024);
    useThreadStore.setState({
      threads: [
        { id: 't1', accountId: 'a1', subject: 'x', isRead: true, isStarred: true } as never,
      ],
      selectedThreadId: 't1',
    });
    render(<ReadRibbon />);

    await waitFor(() => {
      const moveButton = screen.getByRole('button', { name: /move to folder/i });
      const markReadButton = screen.getByRole('button', { name: /mark as unread/i });
      // With labels visible the caret should still be rendered.
      expect(moveButton.querySelectorAll('svg')).toHaveLength(2);
      expect(markReadButton.querySelectorAll('svg')).toHaveLength(2);
    });
  });
});

describe('ReadRibbon reply-with-attachment routing', () => {
  const message: MailMessage = {
    id: 'msg-1',
    subject: 'Hi',
    from: { name: 'Bob', address: 'bob@example.com' },
    to: [{ name: 'Me', address: 'me@example.com' }],
    date: new Date().toISOString(),
    preview: '',
    html: '<p>x</p>',
    text: 'x',
    threadId: 't1',
    messageId: '<mid-1@example.com>',
    classificationId: null,
    isEncrypted: false,
    isSigned: false,
  };

  function selectMessageAndAccount() {
    useViewStore.setState({ selectedMessage: message });
    useAccountStore.setState({
      accounts: [{ id: 'a1', email: 'me@example.com' } as never],
      activeAccountId: 'a1',
    });
  }

  it('main window: opens the docked inline composer with the with-attachments intent', async () => {
    selectMessageAndAccount();
    setRibbonWidth(1024);
    render(<ReadRibbon />);

    fireEvent.click(await screen.findByRole('button', { name: /^reply options$/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /reply with attachment/i }));

    await waitFor(() => {
      const session = useInlineComposerStore.getState().session;
      expect(session).not.toBeNull();
      expect(session?.intent).toBe('replyWithAttachments');
      expect(session?.messageId).toBe('msg-1');
    });
  });

  it('main window: reply-all variant maps to replyAllWithAttachments', async () => {
    selectMessageAndAccount();
    setRibbonWidth(1024);
    render(<ReadRibbon />);

    fireEvent.click(await screen.findByRole('button', { name: /^reply all options$/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /reply all with attachment/i }));

    await waitFor(() => {
      expect(useInlineComposerStore.getState().session?.intent).toBe('replyAllWithAttachments');
    });
  });

  it('viewer window: falls back to the modal composer, no inline session', async () => {
    selectMessageAndAccount();
    setRibbonWidth(1024);
    mockOpenReplyWithAttachments.mockClear();
    render(<ReadRibbon viewer />);

    fireEvent.click(await screen.findByRole('button', { name: /^reply options$/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /reply with attachment/i }));

    expect(mockOpenReplyWithAttachments).toHaveBeenCalledWith(
      message,
      expect.objectContaining({ id: 'a1' }),
    );
    expect(useInlineComposerStore.getState().session).toBeNull();
  });
});
