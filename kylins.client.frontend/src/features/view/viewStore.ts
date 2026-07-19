import { create } from 'zustand';
import type { ReadingPanePosition, MessageListDensity, ViewState, PanelSizeMap } from './types';
import { DEFAULT_VIEW_STATE } from './defaults';
import { isPanelSizeMap } from './viewSettings';
import type { ImapAttachment } from '../../services/db/cryptoReceive';

/**
 * Per-message crypto verification outcome fields surfaced to the UI. All
 * OPTIONAL — non-crypto messages (the common case) carry no crypto result and
 * the UI must treat `undefined` as "no information / not a crypto message".
 * String-literal unions mirror the variants produced by the backend
 * `MessageCryptoResultRow` (`kylins.client.backend/src/db/message_crypto_results.rs`).
 */
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
  // ── G6 Task 1: per-message crypto verification outcome (Phase 1b receive).
  // Set by the G6 open-message handler from `getMessageCryptoResult` /
  // `sync:crypto-result` event payload. All OPTIONAL so non-crypto messages
  // are unaffected.
  /** `'not-signed' | 'valid-verified' | 'valid-unverified' | 'invalid' |
   *  `'unknown-key' | 'mismatch'`. */
  signatureState?:
    | 'not-signed'
    | 'valid-verified'
    | 'valid-unverified'
    | 'invalid'
    | 'unknown-key'
    | 'mismatch';
  /** `'ok' | 'no-key' | 'failed' | 'n/a'`. */
  decryptState?: 'ok' | 'no-key' | 'failed' | 'n/a';
  /** Signer cert email (From↔SAN resolved), when the message was signed. */
  signerEmail?: string | null;
  /** Signer cert fingerprint (SHA-256 hex), when the message was signed. */
  signerFingerprint?: string | null;
  /** `'good' | 'revoked' | 'unchecked'`. */
  revocationState?: 'good' | 'revoked' | 'unchecked';
}

/**
 * Session-only plaintext cache for decrypted S/MIME bodies. Keyed by message
 * id. Held in memory ONLY — never persisted to disk or SQLite. Cleared on
 * lock/logout via `clearDecrypted` (the G6 lock hook wires this when one
 * exists; today the hook is just exposed).
 *
 * DA-Task 3: `attachments` + `isCrypto` carry the decrypted inner-MIME
 * attachment metadata (snake_case `ImapAttachment`) so the AttachmentList can
 * render chips + the ReadingPane can resolve inline `cid:` images WITHOUT a
 * second decrypt. They are populated by the crypto branch of
 * `threadStore.selectThread` from `OpenCryptoResult.attachments`; the plain
 * (non-crypto) path leaves them `undefined`.
 */
export interface DecryptedCacheEntry {
  html: string | null;
  text: string | null;
  /** Decrypted inner-MIME attachments (snake_case wire shape). Undefined for
   *  non-crypto messages and for the cache-hit path before first decrypt. */
  attachments?: ImapAttachment[];
  /** True when the cache entry was produced by `openCryptoMessage`. Drives
   *  the crypto branches of AttachmentList (download) + ReadingPane (inline
   *  image resolution). */
  isCrypto?: boolean;
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
  /** Transient thread selection for the status bar / future multi-select. */
  selectedThreadIds: string[];
  /**
   * G6 Task 1: session-only plaintext cache for decrypted S/MIME bodies.
   * Keyed by message id. IN-MEMORY ONLY — never persisted; cleared by
   * `clearDecrypted` on lock/logout.
   */
  decryptedCache: Record<string, DecryptedCacheEntry>;
  setSelectedMessage: (message: MailMessage | null) => void;
  setInlineReplyMode: (mode: 'reply' | 'replyAll' | 'forward' | null) => void;
  setSelectedThreadIds: (ids: string[]) => void;
  toggleSelectedThreadId: (id: string) => void;
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
  /**
   * Cache the decrypted plaintext for a message id (called by the G6
   * open-message handler after `openCryptoMessage` returns). Replaces any
   * prior entry for the same id. The plaintext never touches disk.
   *
   * DA-Task 3: `attachments` + `isCrypto` are stashed alongside the plaintext
   * so the AttachmentList / ReadingPane inline-image effect can render the
   * decrypted inner-MIME parts without triggering a second decrypt.
   */
  setDecrypted: (
    messageId: string,
    html: string | null,
    text: string | null,
    attachments?: ImapAttachment[],
    isCrypto?: boolean,
  ) => void;
  /**
   * Drop the entire session plaintext cache. Called on lock/logout to ensure
   * decrypted S/MIME bodies are not left in RAM after the user steps away.
   * (No lock/logout hook exists yet in the frontend — when one is added it
   * must call this. Exposed now so the contract is in place.)
   */
  clearDecrypted: () => void;
  resetToDefaults: () => void;
  hydrate: (state: Partial<ViewState>) => void;
}

export const useViewStore = create<ViewStore>((set) => ({
  ...DEFAULT_VIEW_STATE,
  selectedMessage: null,
  inlineReplyMode: null,
  isHydrated: false,
  selectedThreadIds: [],
  decryptedCache: {},

  setSelectedMessage: (selectedMessage) => set({ selectedMessage }),
  setInlineReplyMode: (inlineReplyMode) => set({ inlineReplyMode }),
  setSelectedThreadIds: (selectedThreadIds) => set({ selectedThreadIds }),
  toggleSelectedThreadId: (id) =>
    set((state) => ({
      selectedThreadIds: state.selectedThreadIds.includes(id)
        ? state.selectedThreadIds.filter((x) => x !== id)
        : [...state.selectedThreadIds, id],
    })),
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
  setDecrypted: (messageId, html, text, attachments, isCrypto) =>
    set((state) => ({
      decryptedCache: {
        ...state.decryptedCache,
        [messageId]: { html, text, attachments, isCrypto },
      },
    })),
  clearDecrypted: () => set({ decryptedCache: {} }),

  resetToDefaults: () =>
    set({
      ...DEFAULT_VIEW_STATE,
      selectedMessage: null,
      inlineReplyMode: null,
      selectedThreadIds: [],
      // Plaintext cache is session-only — wipe on reset so a UI reset cannot
      // leave decrypted S/MIME bodies in RAM.
      decryptedCache: {},
    }),

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
