// Store for the docked inline composer (reply / reply-all / forward in the
// reading pane). One active session at a time — the reading pane is a single
// surface, so a single session models it exactly.
//
// Why a store (not component-local state like the old InlineReply):
//   - Retention: switching messages hides the composer but PRESERVES the
//     draft; switching back restores it. Local state died on unmount, which
//     is how in-progress replies were silently lost.
//   - Ownership: discard() always cleans up staged attachment files; pop-out
//     transfers the staging directory to the modal composer instead of
//     orphaning it.
//   - Ribbon: ComposeRibbon reads the active session through
//     useActiveComposerTarget, so its toggles act on the inline draft instead
//     of mutating a store nobody sends from.
//
// Seeding is delegated to draftFactory.buildDraftSeed (aliases, recipients,
// subject, quoted body — all resolved before the editor mounts).

import { create } from 'zustand';
import type { Recipient } from '@/features/composer/contacts';
import type { MailMessage } from '@/features/view/viewStore';
import {
  buildDraftSeed,
  seedOriginalAttachments,
  intentFamily,
  intentIncludesAttachments,
  type DraftSeed,
  type InlineIntent,
} from '@/features/composer/draftFactory';
import {
  participantsForReply,
  participantsForReplyAll,
} from '@/features/composer/recipientsForReply';
import { cleanupAttachments, newDraftId } from '@/services/composer/attachments';
import { openComposerWindow } from '@/utils/composeWindow';
import type { ComposerAttachment, Importance } from './composerStore';
import { useViewStore } from '@/features/view/viewStore';

/** Draft fields shared (by shape) with the modal composerStore. Pop-out is a
 *  field spread of exactly these; drift between the two stores becomes a
 *  compile error at the popOut() call site. */
export interface InlineDraftFields {
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  replyTo: Recipient[];
  subject: string;
  attachments: ComposerAttachment[];
  importance: Importance;
  requestReadReceipt: boolean;
  requestDeliveryReceipt: boolean;
  deliverAt: number | null;
  preventCopy: boolean;
  isEncrypted: boolean;
  isSigned: boolean;
}

export interface InlineSession extends InlineDraftFields {
  /** ViewStore message id this session replies to — visibility key. */
  messageId: string;
  /** The original message (kept for recipient re-resolution and restore). */
  message: MailMessage;
  accountId: string;
  accountEmail: string;
  intent: InlineIntent;
  /** Null while buildDraftSeed is resolving; the dock shows a skeleton. */
  seed: DraftSeed | null;
  seedError: string | null;
  stagingDraftId: string;
  /** True until the user edits anything. Pristine sessions are replaced
   *  silently; non-pristine ones confirm before being discarded. */
  pristine: boolean;
  /** Latest editor HTML (seed body initially; user edits after). Restored
   *  into the editor when the composer remounts after a message switch. */
  bodyHtml: string | null;
  /** Three-state like composerStore: undefined = apply default, null =
   *  explicitly none, string = that signature. */
  signatureId: string | null | undefined;
  classificationId: string | null;
  fromEmail: string | null;
  selfEmails: string[];
  includeOriginalAttachments: boolean;
  /** Threading headers from the seed — consumed by send and pop-out so both
   *  paths thread identically. */
  threadId: string | null;
  inReplyToMessageId: string | null;
}

interface InlineComposerState {
  session: InlineSession | null;

  /** Open a session for (message, intent). Resolves the seed asynchronously;
   *  the dock renders a skeleton until `session.seed` is set. A non-pristine
   *  session for a DIFFERENT message confirms before being discarded. */
  open: (
    intent: InlineIntent,
    message: MailMessage,
    account: { id: string; email: string; displayName?: string | null },
  ) => void;
  /** Discard the session and delete its staged attachment files. Confirms
   *  first when the draft is non-pristine (pass skipConfirm for programmatic
   *  paths that already confirmed). */
  discard: (opts?: { skipConfirm?: boolean }) => void;
  /** Clear the session after a successful send (the backend cleans the
   *  staging directory on send-success — no frontend cleanup). */
  clearAfterSend: () => void;
  /** Transfer the session to the modal composer (pop out), handing over the
   *  staging directory and attachments. Clears the session without cleanup —
   *  ownership moved. */
  popOut: (bodyHtml: string, signatureId: string | null | undefined) => void;

  setTo: (v: Recipient[]) => void;
  setCc: (v: Recipient[]) => void;
  setBcc: (v: Recipient[]) => void;
  setReplyTo: (v: Recipient[]) => void;
  setSubject: (v: string) => void;
  setBodyHtml: (html: string, opts?: { userEdit?: boolean }) => void;
  setSignatureId: (v: string | null | undefined) => void;
  setClassificationId: (v: string | null) => void;
  addAttachment: (a: ComposerAttachment) => void;
  removeAttachment: (id: string) => void;
  setImportance: (v: Importance) => void;
  setRequestReadReceipt: (v: boolean) => void;
  setRequestDeliveryReceipt: (v: boolean) => void;
  setDeliverAt: (v: number | null) => void;
  setPreventCopy: (v: boolean) => void;
  setIsEncrypted: (v: boolean) => void;
  setIsSigned: (v: boolean) => void;
  /** Forward checkbox: toggle only the seeded original attachments — files
   *  the user picked manually are never touched. */
  setIncludeOriginalAttachments: (v: boolean) => void;
  /** Switch reply ↔ replyAll on the open session, preserving recipients the
   *  user added manually (Mailspring updateDraftForReply). */
  switchReplyKind: (kind: 'reply' | 'replyAll') => void;
}

const DEFAULT_DRAFT_FIELDS: InlineDraftFields = {
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: '',
  attachments: [],
  importance: 'normal',
  requestReadReceipt: false,
  requestDeliveryReceipt: false,
  deliverAt: null,
  preventCopy: false,
  isEncrypted: false,
  isSigned: false,
};

function patch(
  state: InlineComposerState,
  p: Partial<InlineSession>,
  opts?: { system?: boolean },
): Pick<InlineComposerState, 'session'> | Record<string, never> {
  if (!state.session) return {};
  return {
    session: {
      ...state.session,
      ...p,
      pristine: opts?.system ? (p.pristine ?? state.session.pristine) : false,
    },
  };
}

export const useInlineComposerStore = create<InlineComposerState>((set, get) => ({
  session: null,

  open: (intent, message, account) => {
    const existing = get().session;
    if (existing && existing.messageId === message.id) {
      // Re-clicking an action on the SAME message must never reset the draft.
      const ef = intentFamily(existing.intent);
      const nf = intentFamily(intent);
      if (ef === nf) {
        // Same family: pure re-click or a with/without-attachments variant
        // change — just toggle the inclusion, seeding/removing as needed.
        if (ef !== 'forward') {
          const wants = intentIncludesAttachments(intent);
          if (wants !== existing.includeOriginalAttachments) {
            get().setIncludeOriginalAttachments(wants);
          }
        }
        return;
      }
      if (ef !== 'forward' && nf !== 'forward') {
        // reply ↔ replyAll: preserve manual recipients (Mailspring pattern),
        // then apply the requested attachment variant.
        get().switchReplyKind(nf);
        const wants = intentIncludesAttachments(intent);
        if (wants !== get().session?.includeOriginalAttachments) {
          get().setIncludeOriginalAttachments(wants);
        }
        return;
      }
      // Forward ↔ reply boundary: a different draft entirely — fall through
      // to the confirm + replace path below.
    }
    if (existing && !existing.pristine) {
      const ok = window.confirm(
        'Discard the unsent reply you were writing? Your text will be lost.',
      );
      if (!ok) return;
    }
    if (existing) {
      // Replacing a session for another message: clean its staged files.
      void cleanupAttachments(existing.stagingDraftId);
    }

    const stagingDraftId = newDraftId();
    // Monotonic token so a slow seed resolution for a replaced session can
    // never overwrite the newer one.
    const token = stagingDraftId;
    set({
      session: {
        ...DEFAULT_DRAFT_FIELDS,
        messageId: message.id,
        message,
        accountId: account.id,
        accountEmail: account.email,
        intent,
        seed: null,
        seedError: null,
        stagingDraftId,
        pristine: true,
        bodyHtml: null,
        signatureId: undefined,
        classificationId: message.classificationId,
        fromEmail: null,
        selfEmails: account.email ? [account.email] : [],
        includeOriginalAttachments: false,
        threadId: null,
        inReplyToMessageId: null,
        isEncrypted: message.isEncrypted,
        isSigned: message.isSigned,
      },
    });

    buildDraftSeed({ account, message, intent })
      .then(async (seed: DraftSeed) => {
        let attachments: ComposerAttachment[] = [];
        if (seed.includeOriginalAttachments && message.messageId) {
          try {
            attachments = await seedOriginalAttachments(
              account.id,
              message.messageId,
              stagingDraftId,
              // Abort staging if this session was discarded/replaced
              // mid-flight — the outbox dir may already be cleaned up.
              () => {
                const cur = get().session;
                return !cur || cur.stagingDraftId !== token;
              },
            );
          } catch (err) {
            console.error('[inlineComposer] failed to seed original attachments', err);
          }
        }
        set((state) => {
          if (!state.session || state.session.stagingDraftId !== token) return {};
          return {
            session: {
              ...state.session,
              seed,
              to: seed.to,
              cc: seed.cc,
              subject: seed.subject,
              bodyHtml: seed.bodyHtml,
              fromEmail: seed.fromEmail,
              selfEmails: seed.selfEmails,
              threadId: seed.threadId,
              inReplyToMessageId: seed.inReplyToMessageId,
              includeOriginalAttachments: seed.includeOriginalAttachments,
              attachments,
            },
          };
        });
      })
      .catch((err) => {
        console.error('[inlineComposer] draft seed failed', err);
        set((state) =>
          state.session && state.session.stagingDraftId === token
            ? { session: { ...state.session, seedError: String(err) } }
            : {},
        );
      });
  },

  discard: (opts) => {
    const s = get().session;
    if (!s) return;
    if (!s.pristine && !opts?.skipConfirm) {
      const ok = window.confirm('Discard this draft? Your text will be lost.');
      if (!ok) return;
    }
    void cleanupAttachments(s.stagingDraftId);
    set({ session: null });
  },

  clearAfterSend: () => set({ session: null }),

  popOut: (bodyHtml, signatureId) => {
    const s = get().session;
    if (!s) return;
    const family = intentFamily(s.intent);
    // Pop out into the dedicated Composer WINDOW (same surface the ribbon's
    // reply actions open). The staging directory and already-staged
    // attachments transfer via URL params — no files re-copied or orphaned,
    // and the popout's seed effect skips re-seeding (attachmentsTransferred).
    void openComposerWindow({
      mode: family,
      to: s.to,
      cc: s.cc,
      bcc: s.bcc,
      replyTo: s.replyTo,
      subject: s.subject,
      bodyHtml,
      accountId: s.accountId,
      // Threading fields come from the seed (stored on the session) so a
      // popped-out draft threads exactly as it would have inline.
      threadId: s.threadId ?? s.message.threadId ?? null,
      inReplyToMessageId:
        s.inReplyToMessageId ?? (family === 'forward' ? null : (s.message.messageId ?? null)),
      fromEmail: s.fromEmail ?? s.accountEmail,
      signatureId,
      classificationId: s.classificationId,
      isEncrypted: s.isEncrypted,
      isSigned: s.isSigned,
      importance: s.importance,
      requestReadReceipt: s.requestReadReceipt,
      requestDeliveryReceipt: s.requestDeliveryReceipt,
      deliverAt: s.deliverAt,
      preventCopy: s.preventCopy,
      originalMessageId: s.message.messageId ?? null,
      includeOriginalAttachments: s.includeOriginalAttachments,
      stagingDraftId: s.stagingDraftId,
      attachments: s.attachments,
    });
    set({ session: null });
  },

  setTo: (to) => set((s) => patch(s, { to })),
  setCc: (cc) => set((s) => patch(s, { cc })),
  setBcc: (bcc) => set((s) => patch(s, { bcc })),
  setReplyTo: (replyTo) => set((s) => patch(s, { replyTo })),
  setSubject: (subject) => set((s) => patch(s, { subject })),
  setBodyHtml: (bodyHtml, opts) => set((s) => patch(s, { bodyHtml }, { system: !opts?.userEdit })),
  setSignatureId: (signatureId) => set((s) => patch(s, { signatureId }, { system: true })),
  setClassificationId: (classificationId) => set((s) => patch(s, { classificationId })),
  addAttachment: (a) =>
    set((s) => patch(s, { attachments: [...(s.session?.attachments ?? []), a] })),
  removeAttachment: (id) =>
    set((s) =>
      patch(s, { attachments: (s.session?.attachments ?? []).filter((a) => a.id !== id) }),
    ),
  setImportance: (importance) => set((s) => patch(s, { importance })),
  setRequestReadReceipt: (requestReadReceipt) => set((s) => patch(s, { requestReadReceipt })),
  setRequestDeliveryReceipt: (requestDeliveryReceipt) =>
    set((s) => patch(s, { requestDeliveryReceipt })),
  setDeliverAt: (deliverAt) => set((s) => patch(s, { deliverAt })),
  setPreventCopy: (preventCopy) => set((s) => patch(s, { preventCopy })),
  setIsEncrypted: (isEncrypted) => set((s) => patch(s, { isEncrypted })),
  setIsSigned: (isSigned) => set((s) => patch(s, { isSigned })),

  setIncludeOriginalAttachments: (value) => {
    const s = get().session;
    if (!s) return;
    if (!value) {
      // Off: drop only the seeded originals; user-picked files stay.
      set((state) =>
        patch(state, {
          includeOriginalAttachments: false,
          attachments: (state.session?.attachments ?? []).filter((a) => a.origin !== 'seeded'),
        }),
      );
      return;
    }
    set((state) => patch(state, { includeOriginalAttachments: true }));
    const messageId = s.message.messageId;
    if (!messageId) return;
    const token = s.stagingDraftId;
    seedOriginalAttachments(s.accountId, messageId, s.stagingDraftId, () => {
      const cur = get().session;
      return !cur || cur.stagingDraftId !== token;
    })
      .then((seeded) => {
        set((state) => {
          if (!state.session || state.session.stagingDraftId !== token) return {};
          return patch(state, {
            attachments: [
              ...(state.session.attachments ?? []).filter((a) => a.origin !== 'seeded'),
              ...seeded,
            ],
          });
        });
      })
      .catch((err) => console.error('[inlineComposer] re-seed attachments failed', err));
  },

  switchReplyKind: (kind) => {
    const s = get().session;
    if (!s || !s.seed) return;
    const family = intentFamily(s.intent);
    if (family === 'forward' || family === kind) return;

    const next = participantsForReplyAll(s.message, s.selfEmails);
    const replyToSet = participantsForReply(s.message, s.selfEmails).to;
    const key = (r: Recipient) => r.email.toLowerCase();
    const currentAll = new Set([...s.to, ...s.cc].map(key));

    let to: Recipient[];
    let cc: Recipient[];
    if (kind === 'replyAll') {
      // Upgrade: keep everything the user has, add any missing reply-all
      // participants to Cc.
      const missing = [...next.to, ...next.cc].filter((r) => !currentAll.has(key(r)));
      to = s.to;
      cc = [...s.cc, ...missing.filter((r) => !s.to.some((t) => key(t) === key(r)))];
    } else {
      // Downgrade: remove only addresses that came from the reply-all set
      // but not the reply set — manually added recipients survive.
      const replyKeys = new Set(replyToSet.map(key));
      const autoCcKeys = new Set(next.cc.map(key));
      to = s.to.filter((r) => !autoCcKeys.has(key(r)) || replyKeys.has(key(r)));
      if (to.length === 0) to = replyToSet;
      cc = s.cc.filter((r) => !autoCcKeys.has(key(r)));
    }

    const intent: InlineIntent =
      kind === 'replyAll'
        ? s.intent === 'replyWithAttachments'
          ? 'replyAllWithAttachments'
          : 'replyAll'
        : s.intent === 'replyAllWithAttachments'
          ? 'replyWithAttachments'
          : 'reply';
    set((state) => patch(state, { to, cc, intent }));
  },
}));

/**
 * True when an inline session exists AND belongs to the currently selected
 * message — i.e. the dock is actually visible in the reading pane. Drives the
 * ReadingPane dock, the AppShell ribbon mode flip, and the
 * useActiveComposerTarget ribbon routing. A retained session for another
 * message (hidden, not lost) returns false.
 */
export function useInlineComposerVisible(): boolean {
  const sessionMessageId = useInlineComposerStore((s) => s.session?.messageId ?? null);
  const selectedId = useViewStore((s) => s.selectedMessage?.id ?? null);
  return sessionMessageId !== null && sessionMessageId === selectedId;
}
