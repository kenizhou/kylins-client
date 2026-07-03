import { useEffect, useState } from 'react';

export type WindowBreakpoint = 'compact' | 'medium' | 'default' | 'wide';

export interface WindowSize {
  width: number;
  height: number;
  breakpoint: WindowBreakpoint;
}

function getBreakpoint(width: number): WindowBreakpoint {
  if (width < 768) return 'compact';
  if (width < 1024) return 'medium';
  if (width < 1440) return 'default';
  return 'wide';
}

function getSize(): WindowSize {
  const width = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const height = typeof window === 'undefined' ? 768 : window.innerHeight;
  return { width, height, breakpoint: getBreakpoint(width) };
}

/**
 * SSR-safe window size hook. Returns the current viewport dimensions and a
 * breakpoint name aligned with the shell responsive strategy.
 *
 * Resize updates are debounced so rapid, continuous resizing doesn't flood
 * React with state updates and trigger unnecessary layout re-renders.
 */
export function useWindowSize(debounceMs = 120): WindowSize {
  const [size, setSize] = useState<WindowSize>(getSize);

  useEffect(() => {
    let timeoutId: number | undefined;

    function handleResize() {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => setSize(getSize()), debounceMs);
    }

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.clearTimeout(timeoutId);
    };
  }, [debounceMs]);

  return size;
}
