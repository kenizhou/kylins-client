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

beforeEach(() => {
  ribbonWidth = 1200;
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
    expect(screen.getByRole('menuitem', { name: /high/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /read receipt/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /encrypt/i })).toBeInTheDocument();
  });

  it('overflow menu actions update composer state', () => {
    ribbonWidth = 500;
    render(<ComposeRibbon />);
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^high$/i }));
    expect(useComposerStore.getState().importance).toBe('high');
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /encrypt/i }));
    expect(useComposerStore.getState().isEncrypted).toBe(true);
  });
});
