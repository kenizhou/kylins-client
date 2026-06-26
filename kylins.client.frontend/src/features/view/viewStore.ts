import { create } from 'zustand';
import type { ReadingPanePosition, MessageListDensity, ViewState } from './types';
import { DEFAULT_VIEW_STATE } from './defaults';

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
}

export interface ViewStore extends ViewState {
  selectedMessage: MailMessage | null;
  setSelectedMessage: (message: MailMessage | null) => void;
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
  selectedMessage: null,

  setSelectedMessage: (selectedMessage) => set({ selectedMessage }),
  setReadingPanePosition: (readingPanePosition) => set({ readingPanePosition }),
  setFolderPaneVisible: (folderPaneVisible) => set({ folderPaneVisible }),
  setCommandRibbonVisible: (commandRibbonVisible) => set({ commandRibbonVisible }),
  setStatusBarVisible: (statusBarVisible) => set({ statusBarVisible }),
  setConversationView: (conversationView) => set({ conversationView }),
  setMessageListDensity: (messageListDensity) => set({ messageListDensity }),
  setVisibleColumnIds: (visibleColumnIds) => set({ visibleColumnIds }),

  resetToDefaults: () => set({ ...DEFAULT_VIEW_STATE, selectedMessage: null }),

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
