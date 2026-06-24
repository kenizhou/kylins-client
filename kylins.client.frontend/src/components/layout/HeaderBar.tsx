import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { MenuIcon, PlusIcon, NotificationIcon, SettingsIcon, UserIcon } from '../icons';
import { useComposerStore } from '../../stores/composerStore';

export function HeaderBar() {
  return (
    <header className="h-10 flex items-center gap-3 px-3 border-b bg-[var(--surface)] border-[var(--border)] text-[var(--foreground)]">
      <div className="flex items-center gap-2 min-w-[120px]">
        <button className="p-1.5 rounded hover:bg-[var(--hover)]" aria-label="Menu">
          <MenuIcon />
        </button>
        <span className="font-bold text-sm">Mailclient</span>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <input
          type="text"
          placeholder="Search mail…"
          className="w-full max-w-[480px] h-7 px-3 text-sm rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
        />
      </div>
      <div className="flex items-center gap-1">
        <InjectedComponentSet role="header:right" />
        <button
          onClick={() => useComposerStore.getState().openComposer()}
          className="flex items-center gap-1.5 px-3 h-7 text-sm rounded bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90"
        >
          <PlusIcon /> New mail
        </button>
        <button className="p-1.5 rounded hover:bg-[var(--hover)]" aria-label="Notifications">
          <NotificationIcon />
        </button>
        <button className="p-1.5 rounded hover:bg-[var(--hover)]" aria-label="Settings">
          <SettingsIcon />
        </button>
        <button className="p-1.5 rounded hover:bg-[var(--hover)]" aria-label="Profile">
          <UserIcon />
        </button>
      </div>
    </header>
  );
}
