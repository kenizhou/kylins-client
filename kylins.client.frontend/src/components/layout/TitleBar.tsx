import { useState, useEffect } from 'react';
import { SearchField, Input, Label, Button } from 'react-aria-components';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUIStore } from '../../stores/uiStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { MenuBar } from '../ui/MenuBar';
import { IconButton } from '../ui/IconButton';
import { WindowControls } from '../ui/WindowTitleBar';
import { MenuIcon, SettingsIcon, UserIcon, CloseIcon, SearchIcon } from '../icons';
import { useWindowSize } from '../../hooks/useWindowSize';

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

export function TitleBar() {
  const activeCategory = useUIStore((s) => s.activeMenuCategory);
  const setActiveCategory = useUIStore((s) => s.setActiveMenuCategory);
  const activeApp = useUIStore((s) => s.activeApp);
  const openPreferences = () => usePreferencesStore.getState().openPreferences('General');
  const openAccountSetup = () => useUIStore.getState().setAccountSetupOpen(true);
  const { breakpoint } = useWindowSize();
  const isCompact = breakpoint === 'compact';
  const [searchOpen, setSearchOpen] = useState(false);
  const isMaximized = useMaximizedState();

  const searchPlaceholder =
    {
      mail: 'Search mail…',
      calendar: 'Search calendar…',
      contacts: 'Search contacts…',
      tasks: 'Search tasks…',
    }[activeApp] ?? 'Search…';

  const showMenuBar = breakpoint === 'default' || breakpoint === 'wide';

  async function handleToggleMaximize() {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch {
      // Ignore in non-Tauri contexts.
    }
  }

  return (
    <div
      className="relative h-[var(--header-h)] flex items-center pl-2 pr-[148px] glass bg-gradient-to-b from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)] shadow-[var(--glass-shadow),var(--chrome-highlight)] select-none"
      style={dragStyle}
    >
      {/* Signature iris hairline along the bottom edge */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px iris-line opacity-70" />
      {/* Left: hamburger + menu bar */}
      <div className="flex items-center flex-shrink-0" style={noDragStyle}>
        <IconButton
          icon={<MenuIcon size={18} />}
          title="Menu"
          active={activeCategory === 'File'}
          onClick={() => setActiveCategory(activeCategory === 'File' ? null : 'File')}
          className="mr-1"
        />
        {showMenuBar && <MenuBar />}
      </div>

      {/* Left drag region: balances the right side and provides a move target */}
      <div
        data-testid="title-bar-drag-region"
        className="flex-1 min-w-[40px] cursor-default"
        style={dragStyle}
        onDoubleClick={handleToggleMaximize}
        aria-label={
          isMaximized ? 'Double-click to restore window' : 'Double-click to maximize window'
        }
        role="button"
      />

      {/* Center: wide, centered search that scales with the window */}
      <div className="flex-shrink-0 flex justify-center px-2" style={noDragStyle}>
        <div className="w-[min(560px,45vw)]">
          {isCompact ? (
            <>
              <IconButton
                icon={<SearchIcon size={18} />}
                title={searchPlaceholder}
                onClick={() => setSearchOpen(true)}
                className="ml-auto"
              />
              {searchOpen && (
                <div
                  className="absolute right-[148px] top-1/2 -translate-y-1/2 z-[var(--z-sticky)]"
                  style={noDragStyle}
                >
                  <SearchField className="relative w-64" aria-label={searchPlaceholder}>
                    {({ isEmpty }) => (
                      <>
                        <Label className="sr-only">{searchPlaceholder}</Label>
                        <Input
                          autoFocus
                          type="search"
                          placeholder={searchPlaceholder}
                          style={noDragStyle}
                          className="w-full h-11 px-3 pr-8 text-sm rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none transition-colors shadow-lg"
                          onBlur={() => setSearchOpen(false)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setSearchOpen(false);
                          }}
                        />
                        {!isEmpty && (
                          <Button
                            style={noDragStyle}
                            aria-label="Clear search"
                            className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 items-center justify-center rounded text-[var(--muted-text)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                          >
                            <CloseIcon size={14} />
                          </Button>
                        )}
                      </>
                    )}
                  </SearchField>
                </div>
              )}
            </>
          ) : (
            <SearchField className="relative w-full" aria-label={searchPlaceholder}>
              {({ isEmpty }) => (
                <>
                  <Label className="sr-only">{searchPlaceholder}</Label>
                  <Input
                    type="search"
                    placeholder={searchPlaceholder}
                    style={noDragStyle}
                    className="w-full h-9 px-3 pr-8 text-sm rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none transition-colors shadow-[var(--shadow-sm)]"
                  />
                  {!isEmpty && (
                    <Button
                      style={noDragStyle}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded text-[var(--muted-text)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    >
                      <CloseIcon size={14} />
                    </Button>
                  )}
                </>
              )}
            </SearchField>
          )}
        </div>
      </div>

      {/* Right drag region: symmetrical move target, keeps the search centered */}
      <div
        data-testid="title-bar-drag-region"
        className="flex-1 min-w-[40px] cursor-default"
        style={dragStyle}
        onDoubleClick={handleToggleMaximize}
        aria-label={
          isMaximized ? 'Double-click to restore window' : 'Double-click to maximize window'
        }
        role="button"
      />

      {/* Right: app icons (window controls are absolutely positioned) */}
      <div className="flex items-center gap-0.5 flex-shrink-0" style={noDragStyle}>
        {!isCompact && (
          <>
            <IconButton
              icon={<SettingsIcon size={16} />}
              title="Settings"
              onClick={openPreferences}
            />
            <IconButton icon={<UserIcon size={16} />} title="Account" onClick={openAccountSetup} />
          </>
        )}
      </div>

      {/* Window controls: fixed to the right so they stay visible at any width */}
      <div
        className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5"
        style={noDragStyle}
      >
        <WindowControls />
      </div>
    </div>
  );
}
