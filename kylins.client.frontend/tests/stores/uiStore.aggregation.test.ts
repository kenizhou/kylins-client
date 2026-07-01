import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../../src/stores/uiStore';

describe('uiStore sync aggregation', () => {
  beforeEach(() => {
    useUIStore.getState().setPendingCount(0); // legacy reset; also clears via init
    useUIStore.setState({ pendingByAccount: {}, syncStateByAccount: {} });
  });

  it('aggregatedPending sums all accounts', () => {
    useUIStore.getState().setPendingForAccount('a', 2);
    useUIStore.getState().setPendingForAccount('b', 3);
    expect(useUIStore.getState().aggregatedPending).toBe(5);
  });

  it('aggregatedPending updates when one account changes', () => {
    useUIStore.getState().setPendingForAccount('a', 2);
    useUIStore.getState().setPendingForAccount('b', 3);
    useUIStore.getState().setPendingForAccount('a', 0);
    expect(useUIStore.getState().aggregatedPending).toBe(3);
  });

  it('setSyncStateForAccount stores the latest state', () => {
    useUIStore.getState().setSyncStateForAccount('a', 'syncing');
    useUIStore.getState().setSyncStateForAccount('a', 'idle');
    expect(useUIStore.getState().syncStateByAccount['a']).toBe('idle');
  });

  it('clearAccount removes both pending and state', () => {
    useUIStore.getState().setPendingForAccount('a', 5);
    useUIStore.getState().setSyncStateForAccount('a', 'error');
    useUIStore.getState().clearAccount('a');
    expect(useUIStore.getState().aggregatedPending).toBe(0);
    expect(useUIStore.getState().syncStateByAccount['a']).toBeUndefined();
  });
});
