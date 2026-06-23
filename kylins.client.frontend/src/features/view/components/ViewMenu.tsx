import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useViewStore } from '../viewStore';
import { ViewSettingsDialog } from './ViewSettingsDialog';
import { MenuItem } from '../../../components/ui/MenuItem';

export function ViewMenu() {
  const [showSettings, setShowSettings] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    appWindow.isFullscreen().then(setIsFullscreen);

    let unlisten: (() => void) | undefined;
    appWindow
      .onResized(async () => {
        setIsFullscreen(await appWindow.isFullscreen());
      })
      .then((u) => {
        unlisten = u;
      });

    return () => {
      unlisten?.();
    };
  }, []);

  const toggleFullscreen = async () => {
    const appWindow = getCurrentWindow();
    const next = !isFullscreen;
    await appWindow.setFullscreen(next);
    setIsFullscreen(next);
  };

  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const commandRibbonVisible = useViewStore((s) => s.commandRibbonVisible);
  const statusBarVisible = useViewStore((s) => s.statusBarVisible);
  const conversationView = useViewStore((s) => s.conversationView);
  const readingPanePosition = useViewStore((s) => s.readingPanePosition);
  const messageListDensity = useViewStore((s) => s.messageListDensity);

  const setFolderPaneVisible = useViewStore((s) => s.setFolderPaneVisible);
  const setCommandRibbonVisible = useViewStore((s) => s.setCommandRibbonVisible);
  const setStatusBarVisible = useViewStore((s) => s.setStatusBarVisible);
  const setConversationView = useViewStore((s) => s.setConversationView);
  const setReadingPanePosition = useViewStore((s) => s.setReadingPanePosition);
  const setMessageListDensity = useViewStore((s) => s.setMessageListDensity);

  return (
    <>
      <MenuItem label="View Settings..." onClick={() => setShowSettings(true)} />

      <MenuItem
        label="Show as Conversations"
        checked={conversationView}
        onClick={() => setConversationView(!conversationView)}
      />

      <div
        className="relative"
        onMouseEnter={() => setActiveSubmenu('density')}
        onMouseLeave={() => setActiveSubmenu(null)}
      >
        <MenuItem label="Message List Items" hasSubmenu />
        {activeSubmenu === 'density' && (
          <div className="absolute top-0 left-full ml-0.5 w-40 bg-[var(--surface)] border border-[var(--border)] shadow-lg rounded py-1 z-50">
            {(['compact', 'normal', 'comfortable'] as const).map((d) => (
              <MenuItem
                key={d}
                label={d.charAt(0).toUpperCase() + d.slice(1)}
                checked={messageListDensity === d}
                onClick={() => setMessageListDensity(d)}
              />
            ))}
          </div>
        )}
      </div>

      <MenuItem
        label="Folder Pane"
        checked={folderPaneVisible}
        onClick={() => setFolderPaneVisible(!folderPaneVisible)}
      />

      <MenuItem
        label="Command Ribbon"
        checked={commandRibbonVisible}
        onClick={() => setCommandRibbonVisible(!commandRibbonVisible)}
      />

      <MenuItem
        label="Status Bar"
        checked={statusBarVisible}
        onClick={() => setStatusBarVisible(!statusBarVisible)}
      />

      <div
        className="relative"
        onMouseEnter={() => setActiveSubmenu('reading')}
        onMouseLeave={() => setActiveSubmenu(null)}
      >
        <MenuItem label="Reading Pane" hasSubmenu />
        {activeSubmenu === 'reading' && (
          <div className="absolute top-0 left-full ml-0.5 w-40 bg-[var(--surface)] border border-[var(--border)] shadow-lg rounded py-1 z-50">
            {(['right', 'bottom', 'off'] as const).map((pos) => (
              <MenuItem
                key={pos}
                label={pos.charAt(0).toUpperCase() + pos.slice(1)}
                checked={readingPanePosition === pos}
                onClick={() => setReadingPanePosition(pos)}
              />
            ))}
          </div>
        )}
      </div>

      <MenuItem label="Full Screen" checked={isFullscreen} onClick={toggleFullscreen} />

      {showSettings && <ViewSettingsDialog onClose={() => setShowSettings(false)} />}
    </>
  );
}
