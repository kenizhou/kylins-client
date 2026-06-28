import { create } from 'zustand';

import type { SkinId } from '../styles/skins';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface UIState {
  theme: ThemeMode;
  skin: SkinId;
  sidebarCollapsed: boolean;
  folderPaneWidth: number;
  messageListWidth: number;
  inspectorPaneVisible: boolean;
  activeToolWindow: string | null;
  activeMenuCategory: string | null;
  activeApp: 'mail' | 'calendar' | 'contacts';
  accountSetupOpen: boolean;
  readerZoom: number;
  /** Count of pending sync operations awaiting replay (0 when fully synced). */
  pendingCount: number;
  setTheme: (theme: ThemeMode) => void;
  setSkin: (skin: SkinId) => void;
  setActiveApp: (app: 'mail' | 'calendar' | 'contacts') => void;
  setAccountSetupOpen: (open: boolean) => void;
  setReaderZoom: (zoom: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setFolderPaneWidth: (width: number) => void;
  setMessageListWidth: (width: number) => void;
  setInspectorPaneVisible: (visible: boolean) => void;
  setActiveToolWindow: (id: string | null) => void;
  setActiveMenuCategory: (category: string | null) => void;
  setPendingCount: (count: number) => void;
}

import { DEFAULT_SKIN } from '../styles/skins';

export const useUIStore = create<UIState>((set) => ({
  theme: 'system',
  skin: DEFAULT_SKIN,
  sidebarCollapsed: false,
  folderPaneWidth: 240,
  messageListWidth: 320,
  inspectorPaneVisible: false,
  activeToolWindow: null,
  activeMenuCategory: null,
  activeApp: 'mail',
  accountSetupOpen: false,
  readerZoom: 1,
  pendingCount: 0,
  setTheme: (theme) => set({ theme }),
  setSkin: (skin) => set({ skin }),
  setActiveApp: (activeApp) => set({ activeApp }),
  setAccountSetupOpen: (accountSetupOpen) => set({ accountSetupOpen }),
  setReaderZoom: (readerZoom) => set({ readerZoom }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setFolderPaneWidth: (folderPaneWidth) => set({ folderPaneWidth }),
  setMessageListWidth: (messageListWidth) => set({ messageListWidth }),
  setInspectorPaneVisible: (inspectorPaneVisible) => set({ inspectorPaneVisible }),
  setActiveToolWindow: (activeToolWindow) => set({ activeToolWindow }),
  setActiveMenuCategory: (activeMenuCategory) => set({ activeMenuCategory }),
  setPendingCount: (pendingCount) => set({ pendingCount }),
}));
