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
      className="mx-2 mt-2 flex min-h-[var(--ribbon-h)] items-stretch justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 shadow-sm"
      aria-label="Command ribbon"
    >
      <div className="flex items-stretch">{children}</div>
    </nav>
  );
}
