import { render, screen, fireEvent } from '@testing-library/react';
import { TitleBar } from '@/components/layout/TitleBar';
import { useUIStore } from '@/stores/uiStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('@/components/ui/WindowTitleBar', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

describe('TitleBar search', () => {
  beforeEach(() => {
    useUIStore.setState({
      activeMenuCategory: null,
      accountSetupOpen: false,
      activeApp: 'mail',
    });
  });

  it('renders a search field with mail placeholder by default', () => {
    render(<TitleBar />);
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Search mail…');
  });

  it('updates placeholder for contacts app', () => {
    useUIStore.setState({ activeApp: 'contacts' });
    render(<TitleBar />);
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', 'Search contacts…');
  });

  it('does not use absolute positioning for search container', () => {
    const { container } = render(<TitleBar />);
    const searchContainer = container.querySelector('.flex-1.flex.justify-center');
    expect(searchContainer).toBeInTheDocument();
  });

  it('shows the clear button only when the search has text and clears on click', () => {
    render(<TitleBar />);
    const input = screen.getByRole('searchbox');

    expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'hello' } });
    const clear = screen.getByRole('button', { name: /clear search/i });
    expect(clear).toBeInTheDocument();

    fireEvent.click(clear);
    expect(input).toHaveValue('');
  });
});
