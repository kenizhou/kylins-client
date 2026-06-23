import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUIStore } from '../../stores/uiStore';
import { MenuBar } from '../ui/MenuBar';
import { MenuIcon, MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon } from '../icons';

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

  return (
    <div
      className="relative h-10 flex items-center justify-between px-2 bg-[var(--surface)] border-b border-[var(--border)] select-none"
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

      {/* Center: search */}
      <div className="flex-1 flex items-center justify-center px-4" style={dragStyle}>
        <input
          type="text"
          placeholder="Search mail…"
          style={noDragStyle}
          className="w-full max-w-[320px] h-7 px-3 text-sm rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
        />
      </div>

      {/* Right: window controls */}
      <div className="flex items-center" style={noDragStyle}>
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
          className="h-7 w-9 inline-flex items-center justify-center text-[var(--muted-text)] hover:bg-red-500 hover:text-white transition-colors"
          aria-label="Close"
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}
