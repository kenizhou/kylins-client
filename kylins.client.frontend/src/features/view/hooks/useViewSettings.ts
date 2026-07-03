import { useEffect } from 'react';
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
  const panelSizes = useViewStore((s) => s.panelSizes);
  const setHydrated = useViewStore((s) => s.setHydrated);
  const isHydrated = useViewStore((s) => s.isHydrated);

  // Hydrate from persisted settings on mount only
  useEffect(() => {
    async function hydrate() {
      const persisted = await loadViewSettings();
      useViewStore.getState().hydrate(persisted);
      setHydrated(true);
    }

    hydrate();
  }, [setHydrated]);

  // Persist on every change after hydration
  useEffect(() => {
    if (!isHydrated) return;

    saveViewSettings({
      readingPanePosition,
      folderPaneVisible,
      commandRibbonVisible,
      statusBarVisible,
      conversationView,
      messageListDensity,
      visibleColumnIds,
      panelSizes,
    });
  }, [
    readingPanePosition,
    folderPaneVisible,
    commandRibbonVisible,
    statusBarVisible,
    conversationView,
    messageListDensity,
    visibleColumnIds,
    panelSizes,
    isHydrated,
  ]);
}
