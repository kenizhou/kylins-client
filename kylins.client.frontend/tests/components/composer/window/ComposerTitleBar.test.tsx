import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const toggleMaximize = vi.fn();
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize,
    close: vi.fn(() => Promise.resolve()),
  })),
}));

import { ComposerTitleBar } from '../../../../src/components/composer/window/ComposerTitleBar';

beforeEach(() => {
  toggleMaximize.mockClear();
  vi.mocked(getCurrentWindow).mockClear();
});

describe('ComposerTitleBar', () => {
  it('renders the given title', () => {
    render(<ComposerTitleBar title="Quarterly report" />);
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
  });

  it('renders the standard window controls', () => {
    render(<ComposerTitleBar title="New Message" />);
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
  });

  it('toggles maximize on double-click of the drag region', () => {
    render(<ComposerTitleBar title="New Message" />);
    fireEvent.doubleClick(screen.getByTestId('composer-title-bar-drag-region'));
    expect(toggleMaximize).toHaveBeenCalledTimes(1);
  });
});
