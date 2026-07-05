import { useEffect, useRef } from 'react';

/**
 * Auto-hide scrollbar styling for a scroll container.
 *
 * The scrollbar track always reserves its width (no layout shift) but the
 * thumb is hidden until the user is actively scrolling. After scrolling stops
 * it hides again after `delay` ms.
 *
 * This hook does NOT use React state for the scroll event, so the consuming
 * component does not re-render on every scroll tick.
 */
export function useAutoHideScrollbar(
  elementRef: React.RefObject<HTMLElement | null>,
  delay = 1000,
) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    const SCROLLING_CLASS = 'is-scrolling';

    const onScroll = () => {
      el.classList.add(SCROLLING_CLASS);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        el.classList.remove(SCROLLING_CLASS);
      }, delay);
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [elementRef, delay]);
}

/** Class name to put on the scroll container. */
export const autoHideScrollbarClass = 'kylins-auto-scrollbar';
