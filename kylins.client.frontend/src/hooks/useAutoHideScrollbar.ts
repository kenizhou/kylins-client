/**
 * Auto-hide scrollbar styling for a scroll container.
 *
 * The hook now returns a stable CSS class string. The actual hide/show
 * behavior is handled by CSS :hover so no scroll listeners are attached.
 */
export function useAutoHideScrollbar(): string {
  return 'kylins-auto-scrollbar scrollbar-thin';
}

/** Class name to put on the scroll container. */
export const autoHideScrollbarClass = 'kylins-auto-scrollbar scrollbar-thin';
