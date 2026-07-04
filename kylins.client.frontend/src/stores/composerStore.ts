// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.

import { create } from 'zustand';
import { parseRecipients, type Recipient } from '@/features/composer/contacts';
import { newDraftId } from '@/services/composer/attachments';

export type Importance = 'low' | 'normal' | 'high';
export type ComposerMode = 'new' | 'reply' | 'replyAll' | 'forward';
export type ComposerViewMode = 'modal' | 'fullpage';

export interface ComposerAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /**
   * Absolute path to the staged copy under
   * `<appData>/outbox-attachments/{stagingDraftId}/`. T7b: this is the
   * canonical payload — the composer never holds base64 for regular
   * attachments. Set at pick-time by the staging helpers in
   * `services/composer/attachments.ts`.
   */
  filePath: string;
}

/**
 * Recipient values may arrive as structured `Recipient[]` (reply pre-fill, the
 * RecipientField chips) or as raw `string[]` (legacy AddressInput, URL params on
 * pop-out, scheduled-email restore). Normalize everything to `Recipient[]` at
 * the store boundary so the rest of the app deals with one shape.
 */
export type RecipientInput = Recipient[] | string[];

function normalizeRecipients(value: RecipientInput | undefined): Recipient[] {
  if (!value || value.length === 0) return [];
  // Distinguish a string[] from a Recipient[] by the first element's type.
  if (typeof value[0] === 'string') {
    return parseRecipients((value as string[]).join(', '));
  }
  return [...(value as Recipient[])];
}

export interface ComposerState {
  isOpen: boolean;
  mode: ComposerMode;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  replyTo: Recipient[];
  subject: string;
  bodyHtml: string;
  threadId: string | null;
  inReplyToMessageId: string | null;
  showCcBcc: boolean;
  draftId: string | null;
  /**
   * Stable per-session id used as the on-disk outbox folder name (the
   * directory attachment files are staged under). This is **distinct** from
   * `draftId` (the persisted `local_drafts` row id): the Rust backend
   * generates its own UUID on insert, so we cannot pre-set the row id from
   * TS. `stagingDraftId` is generated up-front so attachment picks can stage
   * files before the first autoSave creates a row.
   *
   * Lifecycle:
   *  - `openComposer` generates a fresh `stagingDraftId`.
   *  - Pick-time staging writes into `<appData>/outbox-attachments/{stagingDraftId}/`.
   *  - At send time this becomes `SendDraft.draftId`; the T8 backend cleanup
   *    deletes the matching folder on send-success.
   *  - `closeComposer` / discard calls `cleanupAttachments(stagingDraftId)`.
   */
  stagingDraftId: string;
  undoSendTimer: ReturnType<typeof setTimeout> | null;
  undoSendVisible: boolean;
  attachments: ComposerAttachment[];
  lastSavedAt: number | null;
  isSaving: boolean;
  fromEmail: string | null;
  viewMode: ComposerViewMode;
  signatureHtml: string;
  signatureId: string | null;
  classificationId: string | null;
  isEncrypted: boolean;
  isSigned: boolean;
  /** Message importance. Default: normal. */
  importance: Importance;
  /** Request a read receipt from each recipient. */
  requestReadReceipt: boolean;
  /** Request a delivery receipt from each recipient. */
  requestDeliveryReceipt: boolean;
  /** Unix timestamp (ms) when the message should be delivered (delay delivery). */
  deliverAt: number | null;
  /** Best-effort flag; deep IRM/DRM enforcement is backend-side. */
  preventCopy: boolean;
  /** Original message id for reply/forward attachment seeding. */
  originalMessageId: string | null;
  /** When true, seed the composer with the original message's attachments. */
  includeOriginalAttachments: boolean;
  /** When true, attach the original message as a .eml file. */
  forwardAsAttachment: boolean;
  /** Cached original message subject for forward-as-attachment synthesis. */
  originalMessageSubject?: string;
  /** Cached original message body for forward-as-attachment synthesis. */
  originalMessageHtml?: string | null;
  originalMessageText?: string | null;

  openComposer: (opts?: {
    mode?: ComposerMode;
    fromEmail?: string | null;
    to?: RecipientInput;
    cc?: RecipientInput;
    bcc?: RecipientInput;
    replyTo?: RecipientInput;
    subject?: string;
    bodyHtml?: string;
    threadId?: string | null;
    inReplyToMessageId?: string | null;
    draftId?: string | null;
    signatureId?: string | null;
    classificationId?: string | null;
    isEncrypted?: boolean;
    isSigned?: boolean;
    importance?: Importance;
    requestReadReceipt?: boolean;
    requestDeliveryReceipt?: boolean;
    deliverAt?: number | null;
    preventCopy?: boolean;
    originalMessageId?: string | null;
    includeOriginalAttachments?: boolean;
    forwardAsAttachment?: boolean;
    originalMessageSubject?: string;
    originalMessageHtml?: string | null;
    originalMessageText?: string | null;
  }) => void;
  closeComposer: () => void;
  setTo: (to: RecipientInput) => void;
  setCc: (cc: RecipientInput) => void;
  setBcc: (bcc: RecipientInput) => void;
  setReplyTo: (replyTo: RecipientInput) => void;
  setSubject: (subject: string) => void;
  setBodyHtml: (bodyHtml: string) => void;
  setShowCcBcc: (showCcBcc: boolean) => void;
  setDraftId: (id: string | null) => void;
  setStagingDraftId: (id: string) => void;
  setUndoSendTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  setUndoSendVisible: (visible: boolean) => void;
  addAttachment: (attachment: ComposerAttachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setLastSavedAt: (ts: number | null) => void;
  setIsSaving: (saving: boolean) => void;
  setFromEmail: (fromEmail: string | null) => void;
  setViewMode: (mode: ComposerViewMode) => void;
  setSignatureHtml: (signatureHtml: string) => void;
  setSignatureId: (id: string | null) => void;
  setClassificationId: (id: string | null) => void;
  setIsEncrypted: (value: boolean) => void;
  setIsSigned: (value: boolean) => void;
  setImportance: (value: Importance) => void;
  setRequestReadReceipt: (value: boolean) => void;
  setRequestDeliveryReceipt: (value: boolean) => void;
  setDeliverAt: (value: number | null) => void;
  setPreventCopy: (value: boolean) => void;
  setOriginalMessageId: (id: string | null) => void;
  setIncludeOriginalAttachments: (value: boolean) => void;
  setForwardAsAttachment: (value: boolean) => void;
  setOriginalMessageSubject: (value: string) => void;
  setOriginalMessageHtml: (value: string | null) => void;
  setOriginalMessageText: (value: string | null) => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  isOpen: false,
  mode: 'new',
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: '',
  bodyHtml: '',
  threadId: null,
  inReplyToMessageId: null,
  showCcBcc: false,
  draftId: null,
  stagingDraftId: newDraftId(),
  undoSendTimer: null,
  undoSendVisible: false,
  attachments: [],
  viewMode: 'modal',
  fromEmail: null,
  lastSavedAt: null,
  isSaving: false,
  signatureHtml: '',
  signatureId: null,
  classificationId: null,
  isEncrypted: false,
  isSigned: false,
  importance: 'normal',
  requestReadReceipt: false,
  requestDeliveryReceipt: false,
  deliverAt: null,
  preventCopy: false,
  originalMessageId: null,
  includeOriginalAttachments: false,
  forwardAsAttachment: false,
  originalMessageSubject: '',
  originalMessageHtml: null,
  originalMessageText: null,

  openComposer: (opts) =>
    set({
      isOpen: true,
      mode: opts?.mode ?? 'new',
      to: normalizeRecipients(opts?.to),
      cc: normalizeRecipients(opts?.cc),
      bcc: normalizeRecipients(opts?.bcc),
      replyTo: normalizeRecipients(opts?.replyTo),
      subject: opts?.subject ?? '',
      bodyHtml: opts?.bodyHtml ?? '',
      threadId: opts?.threadId ?? null,
      inReplyToMessageId: opts?.inReplyToMessageId ?? null,
      showCcBcc: (opts?.cc?.length ?? 0) > 0 || (opts?.bcc?.length ?? 0) > 0,
      draftId: opts?.draftId ?? null,
      // Always start a fresh staging directory per compose session. Re-opening
      // a persisted draft does NOT reuse its old staging folder (the backend
      // may have already cleaned it up on a prior send); new picks stage anew.
      stagingDraftId: newDraftId(),
      viewMode: 'modal',
      fromEmail: opts?.fromEmail ?? null,
      attachments: [],
      lastSavedAt: null,
      isSaving: false,
      signatureHtml: '',
      signatureId: opts?.signatureId ?? null,
      classificationId: opts?.classificationId ?? null,
      isEncrypted: opts?.isEncrypted ?? false,
      isSigned: opts?.isSigned ?? false,
      importance: opts?.importance ?? 'normal',
      requestReadReceipt: opts?.requestReadReceipt ?? false,
      requestDeliveryReceipt: opts?.requestDeliveryReceipt ?? false,
      deliverAt: opts?.deliverAt ?? null,
      preventCopy: opts?.preventCopy ?? false,
      originalMessageId: opts?.originalMessageId ?? null,
      includeOriginalAttachments: opts?.includeOriginalAttachments ?? false,
      forwardAsAttachment: opts?.forwardAsAttachment ?? false,
      originalMessageSubject: opts?.originalMessageSubject ?? '',
      originalMessageHtml: opts?.originalMessageHtml ?? null,
      originalMessageText: opts?.originalMessageText ?? null,
    }),
  closeComposer: () =>
    set({
      isOpen: false,
      mode: 'new',
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: '',
      bodyHtml: '',
      threadId: null,
      inReplyToMessageId: null,
      showCcBcc: false,
      draftId: null,
      stagingDraftId: newDraftId(),
      viewMode: 'modal',
      fromEmail: null,
      attachments: [],
      lastSavedAt: null,
      isSaving: false,
      signatureHtml: '',
      signatureId: null,
      classificationId: null,
      isEncrypted: false,
      isSigned: false,
      importance: 'normal',
      requestReadReceipt: false,
      requestDeliveryReceipt: false,
      deliverAt: null,
      preventCopy: false,
      originalMessageId: null,
      includeOriginalAttachments: false,
      forwardAsAttachment: false,
      originalMessageSubject: '',
      originalMessageHtml: null,
      originalMessageText: null,
    }),
  setTo: (to) => set({ to: normalizeRecipients(to) }),
  setCc: (cc) => set({ cc: normalizeRecipients(cc) }),
  setBcc: (bcc) => set({ bcc: normalizeRecipients(bcc) }),
  setReplyTo: (replyTo) => set({ replyTo: normalizeRecipients(replyTo) }),
  setSubject: (subject) => set({ subject }),
  setBodyHtml: (bodyHtml) => set({ bodyHtml }),
  setShowCcBcc: (showCcBcc) => set({ showCcBcc }),
  setDraftId: (draftId) => set({ draftId }),
  setStagingDraftId: (stagingDraftId) => set({ stagingDraftId }),
  setUndoSendTimer: (undoSendTimer) => set({ undoSendTimer }),
  setUndoSendVisible: (undoSendVisible) => set({ undoSendVisible }),
  addAttachment: (attachment) =>
    set((state) => ({ attachments: [...state.attachments, attachment] })),
  removeAttachment: (id) =>
    set((state) => ({ attachments: state.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set({ attachments: [] }),
  setLastSavedAt: (lastSavedAt) => set({ lastSavedAt }),
  setIsSaving: (isSaving) => set({ isSaving }),
  setFromEmail: (fromEmail) => set({ fromEmail }),
  setViewMode: (viewMode) => set({ viewMode }),
  setSignatureHtml: (signatureHtml) => set({ signatureHtml }),
  setSignatureId: (signatureId) => set({ signatureId }),
  setClassificationId: (classificationId) => set({ classificationId }),
  setIsEncrypted: (isEncrypted) => set({ isEncrypted }),
  setIsSigned: (isSigned) => set({ isSigned }),
  setImportance: (importance) => set({ importance }),
  setRequestReadReceipt: (requestReadReceipt) => set({ requestReadReceipt }),
  setRequestDeliveryReceipt: (requestDeliveryReceipt) => set({ requestDeliveryReceipt }),
  setDeliverAt: (deliverAt) => set({ deliverAt }),
  setPreventCopy: (preventCopy) => set({ preventCopy }),
  setOriginalMessageId: (id) => set({ originalMessageId: id }),
  setIncludeOriginalAttachments: (value) => set({ includeOriginalAttachments: value }),
  setForwardAsAttachment: (value) => set({ forwardAsAttachment: value }),
  setOriginalMessageSubject: (value) => set({ originalMessageSubject: value }),
  setOriginalMessageHtml: (value) => set({ originalMessageHtml: value }),
  setOriginalMessageText: (value) => set({ originalMessageText: value }),
}));
