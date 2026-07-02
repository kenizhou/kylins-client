import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useViewStore } from '../viewStore';
import { ViewSettingsDialog } from './ViewSettingsDialog';
import { Menu, MenuItem, Popover, SubmenuTrigger } from 'react-aria-components';

const DENSITY_OPTIONS = ['compact', 'normal', 'comfortable'] as const;
const READING_PANE_OPTIONS = ['right', 'bottom', 'off'] as const;

export function ViewMenu() {
  const [showSettings, setShowSettings] = useState(false);
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

  const optionClass =
    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground outline-none hover:bg-hover [&[data-hovered]]:bg-hover [&[data-focused]]:bg-hover disabled:cursor-default disabled:text-muted-text disabled:opacity-50';

  return (
    <>
      <Menu aria-label="View" className="outline-none">
        <MenuItem
          id="view-settings"
          textValue="View Settings"
          onAction={() => setShowSettings(true)}
          className={optionClass}
        >
          <span className="inline-flex w-4 justify-center" />
          View Settings…
        </MenuItem>

        <MenuItem
          id="conversations"
          textValue="Show as Conversations"
          onAction={() => setConversationView(!conversationView)}
          className={optionClass}
        >
          <span className="inline-flex w-4 justify-center">{conversationView ? '✓' : ''}</span>
          Show as Conversations
        </MenuItem>

        <SubmenuTrigger>
          <MenuItem
            id="message-list-items"
            textValue="Message List Items"
            className={`${optionClass} justify-between`}
          >
            <span className="flex items-center gap-2">
              <span className="inline-flex w-4 justify-center" />
              Message List Items
            </span>
            <span className="text-xs text-muted-text">▶</span>
          </MenuItem>
          <Popover className="rounded-md border border-border bg-surface py-1 shadow-lg">
            <Menu
              aria-label="Message list density"
              className="outline-none"
              onAction={(key) => setMessageListDensity(String(key) as typeof messageListDensity)}
            >
              {DENSITY_OPTIONS.map((d) => (
                <MenuItem key={d} id={d} textValue={d} className={optionClass}>
                  <span className="inline-flex w-4 justify-center">
                    {messageListDensity === d ? '✓' : ''}
                  </span>
                  {d.charAt(0).toUpperCase() + d.slice(1)}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </SubmenuTrigger>

        <MenuItem
          id="folder-pane"
          textValue="Folder Pane"
          onAction={() => setFolderPaneVisible(!folderPaneVisible)}
          className={optionClass}
        >
          <span className="inline-flex w-4 justify-center">{folderPaneVisible ? '✓' : ''}</span>
          Folder Pane
        </MenuItem>

        <MenuItem
          id="command-ribbon"
          textValue="Command Ribbon"
          onAction={() => setCommandRibbonVisible(!commandRibbonVisible)}
          className={optionClass}
        >
          <span className="inline-flex w-4 justify-center">{commandRibbonVisible ? '✓' : ''}</span>
          Command Ribbon
        </MenuItem>

        <MenuItem
          id="status-bar"
          textValue="Status Bar"
          onAction={() => setStatusBarVisible(!statusBarVisible)}
          className={optionClass}
        >
          <span className="inline-flex w-4 justify-center">{statusBarVisible ? '✓' : ''}</span>
          Status Bar
        </MenuItem>

        <SubmenuTrigger>
          <MenuItem
            id="reading-pane"
            textValue="Reading Pane"
            className={`${optionClass} justify-between`}
          >
            <span className="flex items-center gap-2">
              <span className="inline-flex w-4 justify-center" />
              Reading Pane
            </span>
            <span className="text-xs text-muted-text">▶</span>
          </MenuItem>
          <Popover className="rounded-md border border-border bg-surface py-1 shadow-lg">
            <Menu
              aria-label="Reading pane position"
              className="outline-none"
              onAction={(key) => setReadingPanePosition(String(key) as typeof readingPanePosition)}
            >
              {READING_PANE_OPTIONS.map((pos) => (
                <MenuItem key={pos} id={pos} textValue={pos} className={optionClass}>
                  <span className="inline-flex w-4 justify-center">
                    {readingPanePosition === pos ? '✓' : ''}
                  </span>
                  {pos.charAt(0).toUpperCase() + pos.slice(1)}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </SubmenuTrigger>

        <MenuItem
          id="fullscreen"
          textValue="Full Screen"
          onAction={toggleFullscreen}
          className={optionClass}
        >
          <span className="inline-flex w-4 justify-center">{isFullscreen ? '✓' : ''}</span>
          Full Screen
        </MenuItem>
      </Menu>

      {showSettings && <ViewSettingsDialog onClose={() => setShowSettings(false)} />}
    </>
  );
}
