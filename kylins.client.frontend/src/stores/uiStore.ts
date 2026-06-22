import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ReadingPanePosition = 'right' | 'bottom' | 'off';
export type Density = 'compact' | 'comfortable';

export interface UIState {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  folderPaneWidth: number;
  messageListWidth: number;
  readingPanePosition: ReadingPanePosition;
  inspectorPaneVisible: boolean;
  activeToolWindow: string | null;
  density: Density;
  setTheme: (theme: ThemeMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setFolderPaneWidth: (width: number) => void;
  setMessageListWidth: (width: number) => void;
  setReadingPanePosition: (position: ReadingPanePosition) => void;
  setInspectorPaneVisible: (visible: boolean) => void;
  setActiveToolWindow: (id: string | null) => void;
  setDensity: (density: Density) => void;
}

export const useUIStore = create<UIState>((set) => ({
  theme: 'system',
  sidebarCollapsed: false,
  folderPaneWidth: 240,
  messageListWidth: 320,
  readingPanePosition: 'right',
  inspectorPaneVisible: false,
  activeToolWindow: null,
  density: 'comfortable',
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setFolderPaneWidth: (folderPaneWidth) => set({ folderPaneWidth }),
  setMessageListWidth: (messageListWidth) => set({ messageListWidth }),
  setReadingPanePosition: (readingPanePosition) => set({ readingPanePosition }),
  setInspectorPaneVisible: (inspectorPaneVisible) => set({ inspectorPaneVisible }),
  setActiveToolWindow: (activeToolWindow) => set({ activeToolWindow }),
  setDensity: (density) => set({ density }),
}));
