import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReadRibbon } from '../../../../src/components/layout/ribbon/ReadRibbon';
import { useViewStore } from '../../../../src/features/view/viewStore';
import { useThreadStore } from '../../../../src/stores/threadStore';
import { useAccountStore } from '../../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../../src/stores/preferencesStore';
import type { Thread } from '../../../../src/services/db/threads';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

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
  useViewStore.setState({ selectedMessage: null, inlineReplyMode: null });
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
});
