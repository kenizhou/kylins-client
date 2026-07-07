import { create } from 'zustand';
import type { ReadingPanePosition, MessageListDensity, ViewState, PanelSizeMap } from './types';
import { DEFAULT_VIEW_STATE } from './defaults';
import { isPanelSizeMap } from './viewSettings';

export interface MailMessage {
  id: string;
  subject: string;
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  // Optional participants/providers do not yet populate these (EAS/IMAP stubs).
  // Reply-AllCc resolution and forward re-attach degrade gracefully when absent.
  cc?: { name: string; address: string }[];
  replyTo?: { name: string; address: string }[];
  attachments?: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    cid?: string | null;
  }[];
  date: string;
  preview: string;
  html: string | null;
  text: string | null;
  threadId?: string | null;
  messageId?: string | null;
  classificationId: string | null;
  isEncrypted: boolean;
  isSigned: boolean;
  /** Best-effort classification flag; deep enforcement is backend-side. */
  preventCopy?: boolean;
  /** Whether the sender requested a read receipt. */
  readReceiptRequested?: boolean;
}

export interface ViewStore extends ViewState {
  selectedMessage: MailMessage | null;
  /**
   * Active inline-reply/forward mode in the ReadingPane, or null when not
   * composing. Mirrored by AppShell so the main CommandRibbon can flip to
   * compose mode (Attach button reachable) while an inline reply is open.
   * Transient — never persisted (not part of ViewState).
   */
  inlineReplyMode: 'reply' | 'replyAll' | 'forward' | null;
  /** True once persisted settings have been loaded. */
  isHydrated: boolean;
  setSelectedMessage: (message: MailMessage | null) => void;
  setInlineReplyMode: (mode: 'reply' | 'replyAll' | 'forward' | null) => void;
  setReadingPanePosition: (position: ReadingPanePosition) => void;
  setFolderPaneVisible: (visible: boolean) => void;
  setCalendarPaneVisible: (visible: boolean) => void;
  setCalendarPaneSize: (size: number) => void;
  setCommandRibbonVisible: (visible: boolean) => void;
  setStatusBarVisible: (visible: boolean) => void;
  setConversationView: (enabled: boolean) => void;
  setMessageListDensity: (density: MessageListDensity) => void;
  setVisibleColumnIds: (ids: string[]) => void;
  setPanelSizes: <P extends ReadingPanePosition>(position: P, sizes: PanelSizeMap[P]) => void;
  setHydrated: (hydrated: boolean) => void;
  resetToDefaults: () => void;
  hydrate: (state: Partial<ViewState>) => void;
}

export const useViewStore = create<ViewStore>((set) => ({
  ...DEFAULT_VIEW_STATE,
  selectedMessage: null,
  inlineReplyMode: null,
  isHydrated: false,

  setSelectedMessage: (selectedMessage) => set({ selectedMessage }),
  setInlineReplyMode: (inlineReplyMode) => set({ inlineReplyMode }),
  setReadingPanePosition: (readingPanePosition) => set({ readingPanePosition }),
  setFolderPaneVisible: (folderPaneVisible) => set({ folderPaneVisible }),
  setCalendarPaneVisible: (calendarPaneVisible) => set({ calendarPaneVisible }),
  setCalendarPaneSize: (calendarPaneSize) => set({ calendarPaneSize }),
  setCommandRibbonVisible: (commandRibbonVisible) => set({ commandRibbonVisible }),
  setStatusBarVisible: (statusBarVisible) => set({ statusBarVisible }),
  setConversationView: (conversationView) => set({ conversationView }),
  setMessageListDensity: (messageListDensity) => set({ messageListDensity }),
  setVisibleColumnIds: (visibleColumnIds) => set({ visibleColumnIds }),
  setPanelSizes: (readingPanePosition, sizes) =>
    set((state) => ({
      panelSizes: { ...state.panelSizes, [readingPanePosition]: sizes },
    })),
  setHydrated: (isHydrated) => set({ isHydrated }),

  resetToDefaults: () =>
    set({ ...DEFAULT_VIEW_STATE, selectedMessage: null, inlineReplyMode: null }),

  hydrate: (partial) =>
    set((current) => ({
      ...current,
      ...partial,
      // Ensure arrays are always arrays even if persisted value is corrupted
      visibleColumnIds: Array.isArray(partial.visibleColumnIds)
        ? partial.visibleColumnIds
        : current.visibleColumnIds,
      // Reject corrupted panel size maps so the layout never receives invalid percentages
      panelSizes:
        partial.panelSizes != null && isPanelSizeMap(partial.panelSizes)
          ? (partial.panelSizes as PanelSizeMap)
          : current.panelSizes,
    })),
}));
