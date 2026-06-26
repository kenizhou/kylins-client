import { create } from 'zustand';
import type { SecurityIndicatorIcons } from './securityIndicatorIcons';
import {
  getDefaultSecurityIndicatorIcons,
  loadSecurityIndicatorIcons,
  saveSecurityIndicatorIcons,
  sanitizeSecurityIndicatorIcons,
} from './securityIndicatorIcons';

interface SecurityIndicatorIconState extends SecurityIndicatorIcons {
  loaded: boolean;
  load: () => Promise<void>;
  setIcons: (icons: SecurityIndicatorIcons) => Promise<void>;
}

export const useSecurityIndicatorIconStore = create<SecurityIndicatorIconState>((set, get) => ({
  ...getDefaultSecurityIndicatorIcons(),
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    const icons = await loadSecurityIndicatorIcons();
    set({ ...icons, loaded: true });
  },

  setIcons: async (icons) => {
    const sanitized = sanitizeSecurityIndicatorIcons(icons);
    set({ ...sanitized });
    await saveSecurityIndicatorIcons(sanitized);
  },
}));
