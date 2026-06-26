import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUIStore } from '../../stores/uiStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { MenuBar } from '../ui/MenuBar';
import {
  MenuIcon,
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  CloseIcon,
  NotificationIcon,
  SettingsIcon,
  UserIcon,
} from '../icons';

const dragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'drag',
};
const noDragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'no-drag',
};

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const activeCategory = useUIStore((s) => s.activeMenuCategory);
  const setActiveCategory = useUIStore((s) => s.setActiveMenuCategory);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    async function init() {
      setIsMaximized(await appWindow.isMaximized());
      unlisten = await appWindow.onResized(async () => {
        setIsMaximized(await appWindow.isMaximized());
      });
    }

    init();

    return () => {
      unlisten?.();
    };
  }, []);

  const handleMinimize = () => getCurrentWindow().minimize();
  const handleToggleMaximize = () => getCurrentWindow().toggleMaximize();
  const handleClose = () => getCurrentWindow().close();
  const handleSettings = () => usePreferencesStore.getState().openPreferences('General');
  const handleAccount = () => useUIStore.getState().setAccountSetupOpen(true);

  return (
    <div
      className="relative h-[var(--header-h)] flex items-center justify-between px-2 bg-[var(--chrome)] select-none"
      style={dragStyle}
    >
      {/* Left: hamburger + menu bar */}
      <div className="flex items-center" style={noDragStyle}>
        <button
          type="button"
          onClick={() => setActiveCategory(activeCategory === 'File' ? null : 'File')}
          className={`p-1.5 rounded hover:bg-[var(--hover)] text-[var(--foreground)] ${activeCategory === 'File' ? 'bg-[var(--hover)]' : ''}`}
          aria-label="Menu"
          aria-expanded={activeCategory === 'File'}
        >
          <MenuIcon />
        </button>

        <MenuBar />
      </div>

      {/* Search: keep it in the title bar, but match the message list's position and width */}
      <div
        className="absolute top-1/2 -translate-y-1/2"
        style={{
          left: 'calc(var(--message-list-left, 3rem) - 0.5rem)',
          width: 'var(--message-list-width, 20rem)',
        }}
      >
        <input
          type="text"
          placeholder="Search mail…"
          style={noDragStyle}
          className="w-full h-7 px-3 text-sm rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
        />
      </div>

      {/* Right: app icons + window controls */}
      <div className="flex items-center" style={noDragStyle}>
        <button
          type="button"
          className="h-7 w-9 inline-flex items-center justify-center text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] transition-colors"
          aria-label="Notifications"
        >
          <NotificationIcon size={16} />
        </button>
        <button
          type="button"
          onClick={handleSettings}
          className="h-7 w-9 inline-flex items-center justify-center text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] transition-colors"
          aria-label="Settings"
        >
          <SettingsIcon size={16} />
        </button>
        <button
          type="button"
          onClick={handleAccount}
          className="h-7 w-9 inline-flex items-center justify-center text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] transition-colors"
          aria-label="Account"
        >
          <UserIcon size={16} />
        </button>

        <button
          type="button"
          onClick={handleMinimize}
          className="h-7 w-9 inline-flex items-center justify-center text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] transition-colors"
          aria-label="Minimize"
        >
          <MinimizeIcon size={14} />
        </button>
        <button
          type="button"
          onClick={handleToggleMaximize}
          className="h-7 w-9 inline-flex items-center justify-center text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)] transition-colors"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="h-7 w-9 inline-flex items-center justify-center text-[var(--muted-text)] hover:bg-[var(--destructive)] hover:text-[var(--primary-fg)] transition-colors"
          aria-label="Close"
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}
