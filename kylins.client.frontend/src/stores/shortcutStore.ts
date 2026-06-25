import { create } from 'zustand';
import {
  shortcutManager,
  type OverridesMap,
  type ShortcutSet,
} from '../services/shortcuts/shortcutManager';

export interface ShortcutState {
  activeSet: ShortcutSet;
  keyMap: Record<string, string>;
  overrides: OverridesMap;
  isHydrated: boolean;

  hydrate: () => Promise<void>;
  setActiveSet: (set: ShortcutSet) => Promise<void>;
  setBinding: (commandId: string, binding: string) => Promise<void>;
  resetBinding: (commandId: string) => Promise<void>;
  resetAll: () => Promise<void>;
}

function syncState(set: (state: Partial<ShortcutState>) => void): void {
  set({
    activeSet: shortcutManager.getActiveSet(),
    keyMap: shortcutManager.getResolvedKeyMap(),
    overrides: shortcutManager.getOverrides(),
    isHydrated: true,
  });
}

export const useShortcutStore = create<ShortcutState>((set) => {
  shortcutManager.subscribe(() => syncState(set));

  return {
    activeSet: 'win',
    keyMap: {},
    overrides: {},
    isHydrated: false,

    hydrate: async () => {
      await shortcutManager.hydrate();
    },

    setActiveSet: async (activeSet) => {
      await shortcutManager.setActiveSet(activeSet);
    },

    setBinding: async (commandId, binding) => {
      await shortcutManager.setBinding(commandId, binding);
    },

    resetBinding: async (commandId) => {
      await shortcutManager.resetBinding(commandId);
    },

    resetAll: async () => {
      await shortcutManager.resetAll();
    },
  };
});
