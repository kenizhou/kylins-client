import { InjectedComponentSet } from '../plugins/InjectedComponentSet';

export function StatusBar() {
  return (
    <footer className="h-6 flex items-center justify-between px-3 text-xs bg-[var(--surface)] text-[var(--muted-text)] border-t border-[var(--border)] shrink-0">
      <span>Synced · 3 accounts · 1 selected</span>
      <InjectedComponentSet role="status-bar" containersRequired={false} />
    </footer>
  );
}
