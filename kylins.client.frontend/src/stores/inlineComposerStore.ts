// Store for the docked inline composer (reply / reply-all / forward in the
// reading pane). One active session at a time — the reading pane is a single
// surface, so a single session models it exactly.
//
// Why a store (not component-local state like the old InlineReply):
//   - Retention: switching messages hides the composer but PRESERVES the
//     draft; switching back restores it. Local state died on unmount, which
//     is how in-progress replies were silently lost.
//   - Ownership: discard() always cleans up staged attachment files; pop-out
//     transfers the staging directory to the OS compose window instead of
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
import { deleteDraft, type DbDraft } from '@/services/composer/drafts';
import { flushInlineDraftSave } from '@/services/composer/inlineDraftAutoSave';
import {
  dbDraftToComposerAttachments,
  dbDraftToDraftSessionFields,
  stagingIdFromAttachmentPath,
} from '@/features/drafts/draftMapping';
import type { DraftSessionFields } from '@/features/composer/draftSession';
import { openComposerWindow } from '@/utils/composeWindow';
import type { ComposerAttachment, Importance } from './composerStore';
import { useViewStore } from '@/features/view/viewStore';

/** What a compose session is anchored to. */
export type ComposeAnchor =
  /** Reply / reply-all / forward: the full source message is held for
   *  recipient re-resolution, attachment seeding, and restore. */
  | { kind: 'reply'; message: MailMessage }
  /** New-message draft (or a reply draft whose source message can no longer
   *  be resolved). Threading headers live on the session itself. */
  | { kind: 'standalone' };

/** Dock intents: the reply/forward set plus 'new' for standalone sessions. */
export type ComposeIntent = InlineIntent | 'new';

/** The source message of a reply-anchored session, else null. Consumers use
 *  this instead of switching on the anchor union ad hoc. */
export function anchorMessage(session: InlineSession | null): MailMessage | null {
  return session?.anchor.kind === 'reply' ? session.anchor.message : null;
}

/** Title for the retained-session resume chip ("Unsent reply to …"). */
export function sessionDisplayTitle(session: InlineSession): string {
  if (session.anchor.kind === 'reply') {
    return session.anchor.message.subject ?? '(no subject)';
  }
  return session.subject || '(no subject)';
}

export interface InlineSession extends Omit<DraftSessionFields, 'attachments' | 'intent'> {
  /** Chips carry a UI id + origin tag; the shared field bag uses the plain
   *  path-backed StoredAttachment shape. */
  attachments: ComposerAttachment[];
  /** Narrowed from the field bag's plain string. */
  intent: ComposeIntent;
  /** What this compose session is anchored to. Reply sessions hold the full
   *  source message (recipient re-resolution, attachment seeding, restore);
   *  standalone sessions (new-message drafts, or reply drafts whose source
   *  message is gone) carry everything they need on the session itself. */
  anchor: ComposeAnchor;
  accountId: string;
  accountEmail: string;
  /** Null while buildDraftSeed is resolving; the dock shows a skeleton. */
  seed: DraftSeed | null;
  seedError: string | null;
  stagingDraftId: string;
  /** Persisted `local_drafts` row id, written by inlineDraftAutoSave once the
   *  session is non-pristine. Every lifecycle exit (send / discard / pop-out /
   *  replace) deletes the row so the Drafts folder never keeps stale drafts. */
  draftId: string | null;
  /** True until the user edits anything. Pristine sessions are replaced
   *  silently; non-pristine ones confirm before being discarded. */
  pristine: boolean;
  selfEmails: string[];
}

interface InlineComposerState {
  session: InlineSession | null;

  /** Open a session for (message, intent). Resolves the seed asynchronously;
   *  the dock renders a skeleton until `session.seed` is set. Replacing a
   *  session for a DIFFERENT message PRESERVES the outgoing draft (flushes
   *  its pending save; the row and staging dir stay — the draft lives on in
   *  the Drafts folder with its [Draft] chip). */
  open: (
    intent: InlineIntent,
    message: MailMessage,
    account: { id: string; email: string; displayName?: string | null },
  ) => Promise<void>;
  /** Restore a session from a persisted `local_drafts` row (app-reload
   *  resume, PASSIVE path — ReadingPane restore-on-select). No-op when any
   *  session already exists — a live or retained session always wins over
   *  resurrecting an old draft. The restored session is non-pristine (it
   *  carries user content) and keeps the row id, so the autosave keeps
   *  updating the same row and every lifecycle exit deletes it. Never wire an
   *  explicit user click to this — use `resumeDraft`. */
  restoreFromDraft: (
    draft: DbDraft,
    message: MailMessage,
    account: { id: string; email: string; displayName?: string | null },
  ) => void;
  /** Resume a persisted draft from an EXPLICIT user click (Drafts folder
   *  single-click). Conflict policy: same draft → focus no-op; a different
   *  session is PRESERVED (flushed + kept in the Drafts folder), never
   *  deleted. Pass `opts.message` when the draft's source message is
   *  available (reply anchor); omit it for new-message drafts (standalone
   *  anchor). */
  resumeDraft: (
    draft: DbDraft,
    account: { id: string; email: string; displayName?: string | null },
    opts?: { message?: MailMessage | null },
  ) => Promise<void>;
  /** Discard the session and delete its staged attachment files. Confirms
   *  first when the draft is non-pristine (pass skipConfirm for programmatic
   *  paths that already confirmed). */
  discard: (opts?: { skipConfirm?: boolean }) => void;
  /** Clear the session after a successful send (the backend cleans the
   *  staging directory on send-success — no frontend cleanup). */
  clearAfterSend: () => void;
  /** Transfer the session to the OS compose window (pop out), handing over the
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

const DEFAULT_DRAFT_FIELDS = {
  to: [] as Recipient[],
  cc: [] as Recipient[],
  bcc: [] as Recipient[],
  replyTo: [] as Recipient[],
  subject: '',
  attachments: [] as ComposerAttachment[],
  importance: 'normal' as Importance,
  requestReadReceipt: false,
  requestDeliveryReceipt: false,
  deliverAt: null,
  preventCopy: false,
  isEncrypted: false,
  isSigned: false,
  originalMessageId: null,
  includeOriginalAttachments: false,
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

/** Fire-and-forget staging-dir cleanup. Best-effort — a fs failure (or a
 *  missing Tauri runtime in tests) must never surface as an unhandled
 *  rejection on the discard path. */
function cleanupStaging(stagingDraftId: string): void {
  void cleanupAttachments(stagingDraftId).catch((e) =>
    console.warn('[inlineComposer] staged attachment cleanup failed (best-effort)', e),
  );
}

/** Best-effort delete of the session's persisted `local_drafts` row (if the
 *  autosave ever wrote one). Fire-and-forget: a failure leaves a stale row in
 *  the Drafts folder, which the user can delete manually — it must never
 *  block the send/discard/pop-out path. Used by the true end-of-life paths
 *  (send / discard / pop-out transfer) — NEVER by replace, which preserves. */
function deletePersistedDraft(s: InlineSession | null): void {
  if (s?.draftId) {
    void deleteDraft(s.draftId).catch((e) =>
      console.warn('[inlineComposer] failed to delete persisted draft row', e),
    );
  }
}

/** Preserve the outgoing session's draft before a replace: flush any pending
 *  save so the `local_drafts` row is complete, then leave the row AND its
 *  staging directory alone — the draft lives on in the Drafts folder with its
 *  [Draft] chip. Pristine sessions have no row and nothing user-written, so
 *  they vanish silently. Never confirms: nothing is ever lost. */
async function preserveSessionDraft(s: InlineSession): Promise<void> {
  if (s.pristine) return;
  try {
    await flushInlineDraftSave();
  } catch (e) {
    console.warn('[inlineComposer] failed to flush outgoing draft before replace', e);
  }
}

/** Build a session from a persisted draft row. The saved draft IS the seed —
 *  the dock skips the skeleton and seeds the editor from the row directly (no
 *  re-seed). Pass the resolved source `message` for a reply anchor, null for
 *  a standalone (new-message / unresolvable) anchor. */
function buildSessionFromDraft(
  draft: DbDraft,
  account: { id: string; email: string; displayName?: string | null },
  message: MailMessage | null,
): InlineSession {
  const f = dbDraftToDraftSessionFields(draft);
  const attachments = dbDraftToComposerAttachments(draft);
  const stagingDraftId =
    (attachments.length > 0 ? stagingIdFromAttachmentPath(attachments[0]!.filePath) : null) ??
    newDraftId();
  const selfEmails = account.email ? [account.email] : [];
  const threadId = f.threadId ?? message?.threadId ?? message?.id ?? null;
  const anchor: ComposeAnchor = message ? { kind: 'reply', message } : { kind: 'standalone' };
  // A standalone anchor can't honor a reply intent (no source message) except
  // 'forward' — a forward's quote lives in the body itself.
  const intent: ComposeIntent = message
    ? (f.intent as ComposeIntent)
    : f.intent === 'forward' || f.intent === 'new'
      ? (f.intent as ComposeIntent)
      : 'new';
  return {
    ...DEFAULT_DRAFT_FIELDS,
    to: f.to,
    cc: f.cc,
    bcc: f.bcc,
    replyTo: f.replyTo,
    subject: f.subject,
    attachments,
    importance: f.importance,
    requestReadReceipt: f.requestReadReceipt,
    requestDeliveryReceipt: f.requestDeliveryReceipt,
    deliverAt: f.deliverAt,
    preventCopy: f.preventCopy,
    isEncrypted: f.isEncrypted,
    isSigned: f.isSigned,
    originalMessageId: f.originalMessageId ?? message?.messageId ?? null,
    includeOriginalAttachments: f.includeOriginalAttachments,
    anchor,
    accountId: account.id,
    accountEmail: account.email,
    intent,
    seed: {
      to: f.to,
      cc: f.cc,
      subject: f.subject,
      bodyHtml: f.bodyHtml ?? '',
      fromEmail: f.fromEmail ?? account.email,
      selfEmails,
      threadId,
      inReplyToMessageId: f.inReplyToMessageId,
      includeOriginalAttachments: f.includeOriginalAttachments,
    },
    seedError: null,
    stagingDraftId,
    draftId: draft.id,
    // PRISTINE on restore: the row already holds exactly this content, so a
    // restore alone must NOT re-save (an unedited re-save would bump
    // updated_at and make the draft jump to the top of the Drafts folder).
    // Any real edit flips pristine via patch() and the autosave resumes.
    pristine: true,
    bodyHtml: f.bodyHtml ?? '',
    signatureId: f.signatureId,
    classificationId: f.classificationId,
    fromEmail: f.fromEmail,
    selfEmails,
    threadId,
    inReplyToMessageId: f.inReplyToMessageId,
  };
}

/** Monotonic open token: the preserve-flush makes `open` await — a second
 *  open fired during that window must win, and the stale one must bail before
 *  touching the session. */
let openSeq = 0;

export const useInlineComposerStore = create<InlineComposerState>((set, get) => ({
  session: null,

  open: async (intent, message, account) => {
    const seq = ++openSeq;
    const existing = get().session;
    const existingMsg = anchorMessage(existing);
    if (existing && existingMsg && existingMsg.id === message.id) {
      // Re-clicking an action on the SAME message must never reset the draft.
      // Reply-anchored sessions always carry a reply-family intent (the 'new'
      // intent only exists on standalone anchors), so the cast is safe.
      const ef = intentFamily(existing.intent as InlineIntent);
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
    if (existing) {
      // Replacing a session for another message: PRESERVE the outgoing draft
      // (flush its pending save; row + staging dir stay in the Drafts folder
      // with the [Draft] chip). No confirm — nothing is lost.
      await preserveSessionDraft(existing);
    }
    // A newer open fired during the flush — it owns the session now.
    if (seq !== openSeq) return;

    const stagingDraftId = newDraftId();
    // Monotonic token so a slow seed resolution for a replaced session can
    // never overwrite the newer one.
    const token = stagingDraftId;
    set({
      session: {
        ...DEFAULT_DRAFT_FIELDS,
        anchor: { kind: 'reply', message },
        accountId: account.id,
        accountEmail: account.email,
        intent,
        seed: null,
        seedError: null,
        stagingDraftId,
        draftId: null,
        pristine: true,
        bodyHtml: null,
        signatureId: undefined,
        classificationId: message.classificationId,
        fromEmail: null,
        selfEmails: account.email ? [account.email] : [],
        includeOriginalAttachments: false,
        originalMessageId: message.messageId ?? null,
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

  restoreFromDraft: (draft, message, account) => {
    if (get().session) return;
    set({ session: buildSessionFromDraft(draft, account, message) });
  },

  resumeDraft: async (draft, account, opts) => {
    const existing = get().session;
    // Same draft already live in the dock — the click is a focus, not a reset.
    if (existing && existing.draftId === draft.id) return;
    if (existing) {
      // A different session is outgoing: PRESERVE it (flush + keep the row),
      // never delete — switching drafts must not destroy the previous one.
      await preserveSessionDraft(existing);
    }
    set({ session: buildSessionFromDraft(draft, account, opts?.message ?? null) });
  },

  discard: (opts) => {
    const s = get().session;
    if (!s) return;
    // Confirm when there's anything to lose: user edits (non-pristine) OR a
    // persisted row (a restored draft — the row is the only copy). A fresh,
    // untouched reply discards silently.
    if ((s.draftId !== null || !s.pristine) && !opts?.skipConfirm) {
      const ok = window.confirm('Discard this draft? Your text will be lost.');
      if (!ok) return;
    }
    cleanupStaging(s.stagingDraftId);
    deletePersistedDraft(s);
    set({ session: null });
  },

  clearAfterSend: () => {
    // The backend cleans the staging directory on send-success; the persisted
    // draft row is the frontend's job (mirrors the windowed Composer).
    deletePersistedDraft(get().session);
    set({ session: null });
  },

  popOut: (bodyHtml, signatureId) => {
    const s = get().session;
    if (!s) return;
    const msg = anchorMessage(s);
    // Standalone sessions pop out as a brand-new compose; reply sessions keep
    // their reply/forward mode (the windowed seed effect re-threads from it).
    const isNew = s.intent === 'new';
    const family = isNew ? 'new' : intentFamily(s.intent as InlineIntent);
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
      threadId: s.threadId ?? msg?.threadId ?? null,
      inReplyToMessageId:
        s.inReplyToMessageId ?? (family === 'forward' || isNew ? null : (msg?.messageId ?? null)),
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
      originalMessageId: msg?.messageId ?? null,
      includeOriginalAttachments: s.includeOriginalAttachments,
      stagingDraftId: s.stagingDraftId,
      attachments: s.attachments,
    });
    // Ownership moved to the pop-out composer, whose own autosave persists a
    // fresh row — delete this session's row so the draft isn't duplicated.
    deletePersistedDraft(s);
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
    const messageId = anchorMessage(s)?.messageId;
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
    // Reply-kind switching is a reply-anchor-only concept: a standalone (new)
    // draft has no source message to re-derive participants from.
    if (!s || !s.seed || s.anchor.kind !== 'reply') return;
    const sourceMessage = s.anchor.message;
    const family = intentFamily(s.intent as InlineIntent);
    if (family === 'forward' || family === kind) return;

    const next = participantsForReplyAll(sourceMessage, s.selfEmails);
    const replyToSet = participantsForReply(sourceMessage, s.selfEmails).to;
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
 * True when an inline session exists AND is anchored to the current
 * reading-pane target — i.e. the dock is actually visible in the reading
 * pane. Drives the ReadingPane dock, the AppShell ribbon mode flip, and the
 * useActiveComposerTarget ribbon routing. Dual-keyed by anchor kind:
 * reply sessions follow the selected message; standalone sessions follow the
 * selected draft row. A retained session for another target (hidden, not
 * lost) returns false.
 */
export function useInlineComposerVisible(): boolean {
  const session = useInlineComposerStore((s) => s.session);
  const selectedMessageId = useViewStore((s) => s.selectedMessage?.id ?? null);
  const selectedDraftId = useViewStore((s) => s.selectedDraftId);
  if (!session) return false;
  return session.anchor.kind === 'reply'
    ? session.anchor.message.id === selectedMessageId
    : session.draftId !== null && session.draftId === selectedDraftId;
}
