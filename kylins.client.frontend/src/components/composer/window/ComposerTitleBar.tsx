import { useEffect, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WindowControls } from '@/components/ui/WindowTitleBar';

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
      try {
        setIsMaximized(await appWindow.isMaximized());
        unlisten = await appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        });
      } catch {
        // Ignore in non-Tauri contexts (e.g. Vitest/jsdom).
      }
    }
    void init();

    return () => {
      unlisten?.();
    };
  }, []);

  return isMaximized;
}

interface ComposerTitleBarProps {
  title: ReactNode;
}

/**
 * Main-window-style glass titlebar for the composer pop-out window. Mirrors
 * components/layout/TitleBar.tsx chrome (gradient, glass shadow, iris
 * hairline, drag regions, pinned WindowControls) without the menu/search.
 */
export function ComposerTitleBar({ title }: ComposerTitleBarProps) {
  const isMaximized = useMaximizedState();

  async function handleToggleMaximize() {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch {
      // Ignore in non-Tauri contexts.
    }
  }

  return (
    <div
      className="relative z-[var(--z-dropdown)] flex h-[var(--header-h)] shrink-0 items-center pl-4 pr-2 glass bg-gradient-to-b from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)] shadow-[var(--glass-shadow),var(--chrome-highlight)] select-none"
      style={dragStyle}
    >
      {/* Signature iris hairline along the bottom edge (main-window motif). */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px iris-line opacity-70" />

      <span className="truncate text-sm font-medium text-[var(--foreground)]">{title}</span>

      <div
        data-testid="composer-title-bar-drag-region"
        className="min-w-[40px] flex-1 cursor-default self-stretch"
        style={dragStyle}
        onDoubleClick={handleToggleMaximize}
        aria-label={
          isMaximized ? 'Double-click to restore window' : 'Double-click to maximize window'
        }
        role="button"
      />

      <div className="flex flex-shrink-0 items-center gap-0.5" style={noDragStyle}>
        <WindowControls />
      </div>
    </div>
  );
}
