// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.

import { create } from 'zustand';
import { parseRecipients, type Recipient } from '@/features/composer/contacts';

export type ComposerMode = 'new' | 'reply' | 'replyAll' | 'forward';
export type ComposerViewMode = 'modal' | 'fullpage';

export interface ComposerAttachment {
  id: string;
  file: File;
  filename: string;
  mimeType: string;
  size: number;
  content: string; // base64
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
    }),
  setTo: (to) => set({ to: normalizeRecipients(to) }),
  setCc: (cc) => set({ cc: normalizeRecipients(cc) }),
  setBcc: (bcc) => set({ bcc: normalizeRecipients(bcc) }),
  setReplyTo: (replyTo) => set({ replyTo: normalizeRecipients(replyTo) }),
  setSubject: (subject) => set({ subject }),
  setBodyHtml: (bodyHtml) => set({ bodyHtml }),
  setShowCcBcc: (showCcBcc) => set({ showCcBcc }),
  setDraftId: (draftId) => set({ draftId }),
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
}));
