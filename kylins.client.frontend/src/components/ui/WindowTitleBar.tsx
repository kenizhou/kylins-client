import { useEffect, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon } from '@/components/icons';

const dragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'drag',
};
const noDragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'no-drag',
};

function useMaximizedState() {
  const [isMaximized, setIsMaximized] = useState(false);

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

  return isMaximized;
}

interface WindowControlsProps {
  className?: string;
}

/**
 * Minimize / maximize / close buttons for a custom title bar. Includes the
 * maximize-state listener so every consumer doesn't duplicate it.
 */
export function WindowControls({ className }: WindowControlsProps) {
  const isMaximized = useMaximizedState();

  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      /* ignore in non-Tauri contexts */
    }
  };

  const handleToggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch {
      /* ignore in non-Tauri contexts */
    }
  };

  const handleClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore in non-Tauri contexts */
    }
  };

  return (
    <div className={`flex items-center ${className ?? ''}`}>
      <button
        type="button"
        onClick={handleMinimize}
        className="inline-flex h-8 w-9 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        title="Minimize"
        aria-label="Minimize"
      >
        <MinimizeIcon size={14} />
      </button>
      <button
        type="button"
        onClick={handleToggleMaximize}
        className="inline-flex h-8 w-9 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        title={isMaximized ? 'Restore' : 'Maximize'}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
      </button>
      <button
        type="button"
        onClick={handleClose}
        className="inline-flex h-8 w-9 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)] hover:text-[var(--primary-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        aria-label="Close window"
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

interface WindowTitleBarProps {
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Full custom title bar for pop-out windows. Renders a draggable bar with a
 * title, optional right-side children, and the standard window controls.
 */
export function WindowTitleBar({ title, children, className }: WindowTitleBarProps) {
  return (
    <div
      className={`flex h-[var(--header-h)] items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 select-none ${className ?? ''}`}
      style={dragStyle}
    >
      <span className="truncate text-sm font-medium text-[var(--foreground)]">{title}</span>
      <div className="flex items-center gap-1" style={noDragStyle}>
        {children}
        <WindowControls />
      </div>
    </div>
  );
}
