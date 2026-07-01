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
  /** Per-account pending count (aggregated across accounts for display). */
  pendingByAccount: Record<string, number>;
  /** Per-account sync state: 'idle' | 'syncing' | 'error' | 'rate_limited'. */
  syncStateByAccount: Record<string, string>;
  /** Sum of all pendingByAccount values. Updated on every setPendingForAccount. */
  aggregatedPending: number;
  /**
   * Accounts currently in a server-imposed rate-limit cooldown (Phase 3f).
   * The viewport body-prefetch hook skips any account in this set — prefetch
   * is low-priority and the next poll will refill the cache once the cooldown
   * lifts. Mirrored from `sync:status` (`state === 'rate_limited'`) in
   * `useSyncEvents`.
   */
  rateLimitedAccountIds: Set<string>;
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
  setPendingForAccount: (accountId: string, pending: number) => void;
  setSyncStateForAccount: (accountId: string, state: string) => void;
  /** Remove an account's entries (call on account deletion). */
  clearAccount: (accountId: string) => void;
  /** Toggle an account's rate-limit flag (Phase 3f → prefetch gate). */
  setRateLimited: (accountId: string, rateLimited: boolean) => void;
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
  pendingByAccount: {},
  syncStateByAccount: {},
  aggregatedPending: 0,
  rateLimitedAccountIds: new Set<string>(),
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
  // Legacy escape hatch (deprecated, one-release bridge): sets the aggregate
  // pending value directly without routing through an account key. Kept so
  // external callers don't break; new code should use setPendingForAccount.
  // NOTE: this also zeroes the per-account map, since the two must stay in sync
  // (otherwise aggregatedPending — recomputed from the map on the next
  // setPendingForAccount — would diverge from the displayed pendingCount).
  setPendingCount: (pendingCount) =>
    set({ pendingCount, aggregatedPending: pendingCount, pendingByAccount: {} }),
  setPendingForAccount: (accountId, pending) =>
    set((state) => {
      const next = { ...state.pendingByAccount, [accountId]: pending };
      const aggregatedPending = Object.values(next).reduce((a, b) => a + b, 0);
      return { pendingByAccount: next, aggregatedPending, pendingCount: aggregatedPending };
    }),
  setSyncStateForAccount: (accountId, syncState) =>
    set((state) => ({
      syncStateByAccount: { ...state.syncStateByAccount, [accountId]: syncState },
    })),
  clearAccount: (accountId) =>
    set((state) => {
      const { [accountId]: _omit, ...restPending } = state.pendingByAccount;
      const { [accountId]: _omitState, ...restState } = state.syncStateByAccount;
      void _omit;
      void _omitState;
      const aggregatedPending = Object.values(restPending).reduce((a, b) => a + b, 0);
      return {
        pendingByAccount: restPending,
        syncStateByAccount: restState,
        aggregatedPending,
        pendingCount: aggregatedPending,
      };
    }),
  setRateLimited: (accountId, rateLimited) =>
    set((s) => {
      const next = new Set(s.rateLimitedAccountIds);
      if (rateLimited) next.add(accountId);
      else next.delete(accountId);
      return { rateLimitedAccountIds: next };
    }),
}));
