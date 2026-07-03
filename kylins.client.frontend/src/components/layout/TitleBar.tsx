import { SearchField, Input, Label, Button } from 'react-aria-components';
import { useUIStore } from '../../stores/uiStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { MenuBar } from '../ui/MenuBar';
import { IconButton } from '../ui/IconButton';
import { WindowControls } from '../ui/WindowTitleBar';
import { MenuIcon, NotificationIcon, SettingsIcon, UserIcon, CloseIcon } from '../icons';

const dragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'drag',
};
const noDragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'no-drag',
};

export function TitleBar() {
  const activeCategory = useUIStore((s) => s.activeMenuCategory);
  const setActiveCategory = useUIStore((s) => s.setActiveMenuCategory);
  const openPreferences = () => usePreferencesStore.getState().openPreferences('General');
  const openAccountSetup = () => useUIStore.getState().setAccountSetupOpen(true);

  return (
    <div
      className="relative h-[var(--header-h)] flex items-center justify-between px-2 bg-[var(--chrome)] select-none"
      style={dragStyle}
    >
      {/* Left: hamburger + menu bar */}
      <div className="flex items-center" style={noDragStyle}>
        <IconButton
          icon={<MenuIcon size={18} />}
          title="Menu"
          active={activeCategory === 'File'}
          onClick={() => setActiveCategory(activeCategory === 'File' ? null : 'File')}
          className="mr-1"
        />
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
        <SearchField className="relative w-full" aria-label="Search mail">
          {({ isEmpty }) => (
            <>
              <Label className="sr-only">Search mail</Label>
              <Input
                type="text"
                placeholder="Search mail…"
                style={noDragStyle}
                className="w-full h-11 px-3 pr-8 text-sm rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none transition-colors"
              />
              {!isEmpty && (
                <Button
                  style={noDragStyle}
                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 items-center justify-center rounded text-[var(--muted-text)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  <CloseIcon size={14} />
                </Button>
              )}
            </>
          )}
        </SearchField>
      </div>

      {/* Right: app icons + window controls */}
      <div className="flex items-center gap-0.5" style={noDragStyle}>
        <IconButton icon={<NotificationIcon size={16} />} title="Notifications" />
        <IconButton icon={<SettingsIcon size={16} />} title="Settings" onClick={openPreferences} />
        <IconButton icon={<UserIcon size={16} />} title="Account" onClick={openAccountSetup} />

        <div className="mx-1 h-5 w-px bg-[var(--border)]" />
        <WindowControls />
      </div>
    </div>
  );
}
