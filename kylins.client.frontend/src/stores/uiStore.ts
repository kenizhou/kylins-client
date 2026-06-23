import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface UIState {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  folderPaneWidth: number;
  messageListWidth: number;
  inspectorPaneVisible: boolean;
  activeToolWindow: string | null;
  activeMenuCategory: string | null;
  setTheme: (theme: ThemeMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setFolderPaneWidth: (width: number) => void;
  setMessageListWidth: (width: number) => void;
  setInspectorPaneVisible: (visible: boolean) => void;
  setActiveToolWindow: (id: string | null) => void;
  setActiveMenuCategory: (category: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  theme: 'system',
  sidebarCollapsed: false,
  folderPaneWidth: 240,
  messageListWidth: 320,
  inspectorPaneVisible: false,
  activeToolWindow: null,
  activeMenuCategory: null,
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setFolderPaneWidth: (folderPaneWidth) => set({ folderPaneWidth }),
  setMessageListWidth: (messageListWidth) => set({ messageListWidth }),
  setInspectorPaneVisible: (inspectorPaneVisible) => set({ inspectorPaneVisible }),
  setActiveToolWindow: (activeToolWindow) => set({ activeToolWindow }),
  setActiveMenuCategory: (activeMenuCategory) => set({ activeMenuCategory }),
}));
