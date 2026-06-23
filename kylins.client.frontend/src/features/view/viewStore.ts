import { create } from 'zustand';
import type { ReadingPanePosition, MessageListDensity, ViewState } from './types';
import { DEFAULT_VIEW_STATE } from './defaults';

export interface ViewStore extends ViewState {
  setReadingPanePosition: (position: ReadingPanePosition) => void;
  setFolderPaneVisible: (visible: boolean) => void;
  setCommandRibbonVisible: (visible: boolean) => void;
  setStatusBarVisible: (visible: boolean) => void;
  setConversationView: (enabled: boolean) => void;
  setMessageListDensity: (density: MessageListDensity) => void;
  setVisibleColumnIds: (ids: string[]) => void;
  resetToDefaults: () => void;
  hydrate: (state: Partial<ViewState>) => void;
}

export const useViewStore = create<ViewStore>((set) => ({
  ...DEFAULT_VIEW_STATE,

  setReadingPanePosition: (readingPanePosition) => set({ readingPanePosition }),
  setFolderPaneVisible: (folderPaneVisible) => set({ folderPaneVisible }),
  setCommandRibbonVisible: (commandRibbonVisible) => set({ commandRibbonVisible }),
  setStatusBarVisible: (statusBarVisible) => set({ statusBarVisible }),
  setConversationView: (conversationView) => set({ conversationView }),
  setMessageListDensity: (messageListDensity) => set({ messageListDensity }),
  setVisibleColumnIds: (visibleColumnIds) => set({ visibleColumnIds }),

  resetToDefaults: () => set({ ...DEFAULT_VIEW_STATE }),

  hydrate: (partial) =>
    set((current) => ({
      ...current,
      ...partial,
      // Ensure arrays are always arrays even if persisted value is corrupted
      visibleColumnIds: Array.isArray(partial.visibleColumnIds)
        ? partial.visibleColumnIds
        : current.visibleColumnIds,
    })),
}));
