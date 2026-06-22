import { describe, it, expect } from 'vitest';
import { useUIStore } from '../../src/stores/uiStore';

describe('uiStore', () => {
  it('updates theme', () => {
    useUIStore.getState().setTheme('dark');
    expect(useUIStore.getState().theme).toBe('dark');
  });

  it('updates reading pane position', () => {
    useUIStore.getState().setReadingPanePosition('bottom');
    expect(useUIStore.getState().readingPanePosition).toBe('bottom');
  });

  it('updates density', () => {
    useUIStore.getState().setDensity('compact');
    expect(useUIStore.getState().density).toBe('compact');
  });
});
