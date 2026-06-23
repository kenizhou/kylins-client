import { describe, it, expect } from 'vitest';
import { useUIStore } from '../../src/stores/uiStore';

describe('uiStore', () => {
  it('updates theme', () => {
    useUIStore.getState().setTheme('dark');
    expect(useUIStore.getState().theme).toBe('dark');
  });
});
