/**
 * Auto-hide scrollbar styling for a scroll container.
 *
 * Returns a stable CSS class string. The actual hide/show behavior is handled
 * by CSS :hover, so no scroll listeners are attached and no React state is
 * used. Kept as a hook-shaped API so existing callers do not need to change.
 */
export function useAutoHideScrollbar(): string {
  return autoHideScrollbarClass;
}

/** Class name to put on the scroll container. */
export const autoHideScrollbarClass = 'kylins-auto-scrollbar';
