import { InjectedComponentSet } from '../plugins/InjectedComponentSet';

export function StatusBar() {
  return (
    <footer className="h-6 flex items-center justify-between px-3 text-[11px] bg-[var(--surface)] text-[var(--muted-text)] border-t border-[var(--border)] shrink-0">
      <div className="flex items-center gap-3">
        <span>Synced · 3 accounts</span>
        <span>1 selected</span>
      </div>
      <div className="flex items-center gap-3">
        <InjectedComponentSet role="status-bar" containersRequired={false} />
        <span>Compact</span>
        <span>Reading pane right</span>
      </div>
    </footer>
  );
}
