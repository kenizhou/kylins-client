import { useEffect, useRef } from 'react';
import { useViewStore } from '../viewStore';
import { loadViewSettings, saveViewSettings } from '../viewSettings';

export function useViewSettings() {
  const readingPanePosition = useViewStore((s) => s.readingPanePosition);
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const commandRibbonVisible = useViewStore((s) => s.commandRibbonVisible);
  const statusBarVisible = useViewStore((s) => s.statusBarVisible);
  const conversationView = useViewStore((s) => s.conversationView);
  const messageListDensity = useViewStore((s) => s.messageListDensity);
  const visibleColumnIds = useViewStore((s) => s.visibleColumnIds);
  const isHydrated = useRef(false);

  // Hydrate from persisted settings on mount only
  useEffect(() => {
    async function hydrate() {
      const persisted = await loadViewSettings();
      useViewStore.getState().hydrate(persisted);
      isHydrated.current = true;
    }

    hydrate();
  }, []);

  // Persist on every change after hydration
  useEffect(() => {
    if (!isHydrated.current) return;

    saveViewSettings({
      readingPanePosition,
      folderPaneVisible,
      commandRibbonVisible,
      statusBarVisible,
      conversationView,
      messageListDensity,
      visibleColumnIds,
    });
  }, [
    readingPanePosition,
    folderPaneVisible,
    commandRibbonVisible,
    statusBarVisible,
    conversationView,
    messageListDensity,
    visibleColumnIds,
  ]);
}
