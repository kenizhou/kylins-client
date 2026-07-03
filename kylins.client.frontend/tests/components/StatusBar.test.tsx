import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBar } from '../../src/components/layout/StatusBar';
import { useUIStore } from '../../src/stores/uiStore';
import { useAccountStore } from '../../src/stores/accountStore';

// InjectComponentSet is mocked away so we don't pull the plugin registry in.
vi.mock('../../src/components/plugins/InjectedComponentSet', () => ({
  InjectedComponentSet: () => null,
}));

describe('StatusBar sync indicator', () => {
  beforeEach(() => {
    useUIStore.setState({
      pendingByAccount: {},
      syncStateByAccount: {},
      aggregatedPending: 0,
      pendingCount: 0,
    });
    useAccountStore.setState({ accounts: [] });
  });

  it('shows "Synced · just now" when default account synced seconds ago', () => {
    const now = Math.floor(Date.now() / 1000);
    useAccountStore.setState({
      accounts: [{ id: 'a', isDefault: true, lastSyncAt: now - 10 } as never],
    });
    render(<StatusBar />);
    expect(screen.getByText(/Synced · just now/)).toBeInTheDocument();
  });

  it('shows "Syncing…" when any account is syncing', () => {
    useUIStore.getState().setSyncStateForAccount('a', 'syncing');
    render(<StatusBar />);
    expect(screen.getByText(/Syncing…/)).toBeInTheDocument();
  });

  it('shows "Offline — N pending" with aggregated pending > 0 and not syncing', () => {
    useUIStore.getState().setPendingForAccount('a', 3);
    render(<StatusBar />);
    expect(screen.getByText(/Offline — 3 pending/)).toBeInTheDocument();
  });

  it('shows "Rate limited" when state is rate_limited', () => {
    useUIStore.getState().setSyncStateForAccount('a', 'rate_limited');
    render(<StatusBar />);
    expect(screen.getByText(/Rate limited/)).toBeInTheDocument();
  });

  it('shows "Sync error" when state is error', () => {
    useUIStore.getState().setSyncStateForAccount('a', 'error');
    render(<StatusBar />);
    expect(screen.getByText(/Sync error/)).toBeInTheDocument();
  });
});
