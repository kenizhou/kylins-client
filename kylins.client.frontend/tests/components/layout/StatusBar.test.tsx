import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StatusBar } from '@/components/layout/StatusBar';
import { useViewStore } from '@/features/view/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { invoke } from '@tauri-apps/api/core';
import { vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('@/components/plugins/InjectedComponentSet', () => ({
  InjectedComponentSet: () => null,
}));

describe('StatusBar', () => {
  beforeEach(() => {
    useViewStore.setState({ selectedThreadIds: [] });
    useUIStore.setState({ readerZoom: 1 });
    vi.mocked(invoke).mockClear();
  });

  it('shows correct selected count', () => {
    useViewStore.setState({ selectedThreadIds: ['t1', 't2'] });
    render(<StatusBar />);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('hides selected count when none selected', () => {
    useViewStore.setState({ selectedThreadIds: [] });
    render(<StatusBar />);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('displays zoom percentage', () => {
    useUIStore.setState({ readerZoom: 1.25 });
    render(<StatusBar />);
    expect(screen.getByText('125%')).toBeInTheDocument();
  });

  it('triggers a sync when the sync status is clicked', async () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByLabelText('Sync now'));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('sync_start');
    });
  });
});
