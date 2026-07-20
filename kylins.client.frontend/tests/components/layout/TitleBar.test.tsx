import { render, screen, fireEvent } from '@testing-library/react';
import { TitleBar } from '@/components/layout/TitleBar';
import { useUIStore } from '@/stores/uiStore';
import type { WindowBreakpoint } from '@/hooks/useWindowSize';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const toggleMaximize = vi.fn();
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
    toggleMaximize,
  }),
}));

vi.mock('@/components/ui/WindowTitleBar', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

let currentBreakpoint: WindowBreakpoint = 'default';
vi.mock('@/hooks/useWindowSize', () => ({
  useWindowSize: () => ({
    width: 1024,
    height: 768,
    get breakpoint() {
      return currentBreakpoint;
    },
  }),
}));

describe('TitleBar search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('renders draggable regions on both sides of the search', () => {
    render(<TitleBar />);
    const dragRegions = screen.getAllByTestId('title-bar-drag-region');
    expect(dragRegions).toHaveLength(2);
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

  it('toggles maximize on double-click of a drag region', () => {
    render(<TitleBar />);
    const dragRegions = screen.getAllByTestId('title-bar-drag-region');
    expect(dragRegions[0]).toBeTruthy();
    fireEvent.doubleClick(dragRegions[0]!);
    expect(toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it('keeps the search field visible (compressed) at medium width', () => {
    currentBreakpoint = 'medium';
    render(<TitleBar />);
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
    expect(screen.getByTestId('window-controls')).toBeInTheDocument();
  });

  it('hides MenuBar at medium width to prevent overflow', () => {
    currentBreakpoint = 'medium';
    render(<TitleBar />);
    // MenuBar renders multiple menu buttons; at medium width none should appear.
    expect(
      screen.queryAllByRole('button', { name: /^(File|Edit|View|Go|Tools|Help)$/i }),
    ).toHaveLength(0);
  });

  it('hides MenuBar, Settings and Account icons at compact width but keeps window controls', () => {
    currentBreakpoint = 'compact';
    render(<TitleBar />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /account/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('window-controls')).toBeInTheDocument();
  });

  it('always keeps window controls visible even at compact width', () => {
    currentBreakpoint = 'compact';
    render(<TitleBar />);
    expect(screen.getByTestId('window-controls')).toBeVisible();
  });
});
