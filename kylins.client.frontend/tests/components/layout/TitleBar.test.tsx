import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TitleBar } from '../../../src/components/layout/TitleBar';
import { useUIStore } from '../../../src/stores/uiStore';

vi.mock('../../../src/components/ui/WindowTitleBar', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

describe('TitleBar', () => {
  beforeEach(() => {
    useUIStore.setState({
      activeMenuCategory: null,
      accountSetupOpen: false,
    });
  });

  it('renders the global search field', () => {
    render(<TitleBar />);
    expect(screen.getByLabelText(/search mail/i)).toBeInTheDocument();
  });

  it('shows the clear button only when the search has text and clears on click', () => {
    render(<TitleBar />);
    const input = screen.getByLabelText(/search mail/i);

    expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'hello' } });
    const clear = screen.getByRole('button', { name: /clear search/i });
    expect(clear).toBeInTheDocument();

    fireEvent.click(clear);
    expect(input).toHaveValue('');
  });
});
