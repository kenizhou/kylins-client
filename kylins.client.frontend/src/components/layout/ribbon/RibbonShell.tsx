import type { ReactNode } from 'react';

export interface RibbonShellProps {
  children: ReactNode;
}

/**
 * Shared chrome for the command ribbon. Read/Compose ribbons render their groups
 * inside this shell.
 */
export function RibbonShell({ children }: RibbonShellProps) {
  return (
    <nav
      className="mx-1 mt-1 flex min-h-[var(--ribbon-h)] min-w-0 flex-col items-stretch justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-1 shadow-sm md:mx-2 md:mt-2 md:px-3 md:py-1.5"
      aria-label="Command ribbon"
    >
      <div className="flex min-w-0 flex-wrap items-stretch gap-y-1">{children}</div>
    </nav>
  );
}
