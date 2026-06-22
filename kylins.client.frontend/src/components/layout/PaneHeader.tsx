import { InjectedComponentSet } from '../plugins/InjectedComponentSet';

interface PaneHeaderProps {
  title: string;
  role: string;
}

export function PaneHeader({ title, role }: PaneHeaderProps) {
  return (
    <div className="h-8 flex items-center justify-between px-3 border-b bg-[var(--surface)] border-[var(--border)] text-[var(--foreground)] shrink-0">
      <span className="text-sm font-semibold">{title}</span>
      <InjectedComponentSet role={role} containersRequired={false} />
    </div>
  );
}
