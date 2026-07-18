import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoHideScrollbar } from '../../src/hooks/useAutoHideScrollbar';

describe('useAutoHideScrollbar', () => {
  it('returns the combined CSS class string', () => {
    const { result } = renderHook(() => useAutoHideScrollbar());
    expect(result.current).toBe('kylins-auto-scrollbar scrollbar-thin');
  });
});
