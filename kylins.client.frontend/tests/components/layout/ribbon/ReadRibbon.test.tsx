import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ReadRibbon } from '../../../../src/components/layout/ribbon/ReadRibbon';
import { useViewStore } from '../../../../src/features/view/viewStore';
import { useThreadStore } from '../../../../src/stores/threadStore';
import { useAccountStore } from '../../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

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
});
