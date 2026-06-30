import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../../src/stores/uiStore';

describe('uiStore', () => {
  it('updates theme', () => {
    useUIStore.getState().setTheme('dark');
    expect(useUIStore.getState().theme).toBe('dark');
  });

  describe('rateLimitedAccountIds', () => {
    // The set is module-scoped (Zustand singleton); reset between tests so
    // one test's flag doesn't leak into the next.
    beforeEach(() => {
      for (const id of useUIStore.getState().rateLimitedAccountIds) {
        useUIStore.getState().setRateLimited(id, false);
      }
    });

    it('adds an account to the set when rate-limited', () => {
      useUIStore.getState().setRateLimited('acc-1', true);
      expect(useUIStore.getState().rateLimitedAccountIds.has('acc-1')).toBe(true);
    });

    it('removes an account when rate-limit lifts', () => {
      useUIStore.getState().setRateLimited('acc-1', true);
      useUIStore.getState().setRateLimited('acc-1', false);
      expect(useUIStore.getState().rateLimitedAccountIds.has('acc-1')).toBe(false);
    });

    it('does not mutate the previous Set instance (replaces it)', () => {
      const before = useUIStore.getState().rateLimitedAccountIds;
      useUIStore.getState().setRateLimited('acc-2', true);
      const after = useUIStore.getState().rateLimitedAccountIds;
      expect(after).not.toBe(before);
      expect(before.has('acc-2')).toBe(false);
      expect(after.has('acc-2')).toBe(true);
    });

    it('clearing a non-present account is a no-op (no throw)', () => {
      expect(() => useUIStore.getState().setRateLimited('never', false)).not.toThrow();
    });
  });
});
