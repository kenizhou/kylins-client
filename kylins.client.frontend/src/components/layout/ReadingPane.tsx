import { useEffect, useState } from 'react';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { MailIcon } from '../icons';
import { useViewStore } from '../../features/view/viewStore';
import { useAccountStore } from '../../stores/accountStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useThreadStore } from '../../stores/threadStore';
import { useUIStore } from '../../stores/uiStore';
import { AttachmentList } from '../email/AttachmentList';
import { EmailRenderer } from '../email/EmailRenderer';
import { fetchAttachment, fetchInlineImages, getAttachments } from '../../services/db/attachments';
import { upsertContact } from '../../services/db/contacts';
import { InlineReply } from '../email/InlineReply';
import { MessageHeader } from '../../features/viewer/MessageHeader';
import { RsvpCard } from '../../features/viewer/RsvpCard';
import { readTextFile, readFile } from '@tauri-apps/plugin-fs';
import { archiveThread, trashThread, junkThread } from '../../services/mail/actions';
import { useClassification } from '../../features/classification/useClassification';
import { isProminent } from '../../features/classification/classificationStyle';
import { ClassificationBanner } from '../../features/classification/components/ClassificationBanner';
import { ClassificationWatermark } from '../../features/classification/components/ClassificationWatermark';
import { ClassificationBadge } from '../../features/classification/components/ClassificationBadge';
import { SecurityChips } from '../../features/classification/components/SecurityChips';
import { CryptoBadge } from '../../features/view/CryptoBadge';
import { SignatureDetailsDialog } from '../email/SignatureDetailsDialog';
import { TrustDialog } from '../email/TrustDialog';
import { IcalHelper, type ParsedEvent } from '../../services/calendar/icalHelper';

export function ReadingPane() {
  const message = useViewStore((s) => s.selectedMessage);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const account = activeAccountId ? (accounts.find((a) => a.id === activeAccountId) ?? null) : null;
  const accountEmail = account?.email ?? null;
  const accountDisplayName = account?.displayName ?? null;
  const automaticallyLoadImages = usePreferencesStore((s) => s.automaticallyLoadImages);
  const openPreferences = usePreferencesStore((s) => s.openPreferences);
  const readerZoom = useUIStore((s) => s.readerZoom);
  const { getLevelById } = useClassification();
  const selectedThread = useThreadStore((s) => s.threads.find((t) => t.id === s.selectedThreadId));
  const markThreadRead = useThreadStore((s) => s.markThreadRead);
  // Inline reply/forward mode is held in viewStore (not local state) so the
  // AppShell's CommandRibbon can observe it and flip to compose mode (Attach
  // button reachable) while an inline reply is open in the reading pane.
  const inlineReplyMode = useViewStore((s) => s.inlineReplyMode);
  const setInlineReplyMode = useViewStore((s) => s.setInlineReplyMode);
  const [cidMap, setCidMap] = useState<Map<string, string>>(new Map());
  const [contactAdded, setContactAdded] = useState(false);
  const [inviteEvents, setInviteEvents] = useState<ParsedEvent[]>([]);
  // G6 Task 5: TrustDialog dismissal tracking. The user can dismiss the trust
  // prompt for the current message (Escape / backdrop / "Don't trust") without
  // it re-popping on every re-render. Reset whenever the selected message
  // changes so a fresh selection re-prompts.
  const [dismissedTrustMsgId, setDismissedTrustMsgId] = useState<string | undefined>(undefined);
  // G6 follow-up: "Signature details…" dialog open state. Reset on message
  // change (same prev-value block as dismissedTrustMsgId) so the dialog never
  // leaks across selections.
  const [showSignatureDetails, setShowSignatureDetails] = useState(false);
  // Reset per-message ephemeral state when the selected message changes. Uses
  // the prev-value render pattern (setState-during-render to correct stale
  // state) rather than setState-in-effect (the project's eslint rule
  // react-hooks/set-state-in-effect rejects synchronous setState in effects).
  const [activeMsgId, setActiveMsgId] = useState<string | undefined>(message?.id);
  if (message?.id !== activeMsgId) {
    setActiveMsgId(message?.id);
    setInlineReplyMode(null);
    setCidMap(new Map());
    setInviteEvents([]);
    setDismissedTrustMsgId(undefined);
    setShowSignatureDetails(false);
  }
  if (!message?.id && inviteEvents.length > 0) {
    setInviteEvents([]);
  }

  // G6 Task 5: derive the TrustDialog mount from the selected message's
  // signature state. The dialog is shown when ALL of:
  //   - we have an account + signer fingerprint (no point prompting without
  //     a key to write the decision against),
  //   - signatureState is one of the user-decidable states
  //     (`valid-unverified` | `unknown-key` | `mismatch`),
  //   - the user hasn't already dismissed the prompt for THIS message.
  // Derived synchronously per render — no effect, so it can't get out of sync
  // with `message`.
  type DecidableSignatureState = 'valid-unverified' | 'unknown-key' | 'mismatch';
  const DECIDABLE: ReadonlySet<DecidableSignatureState> = new Set([
    'valid-unverified',
    'unknown-key',
    'mismatch',
  ]);
  type PendingTrust = {
    accountId: string;
    messageId: string;
    signerEmail: string | null;
    signerFingerprint: string;
    signatureState: DecidableSignatureState;
    chainInfo: string | null;
  };
  let pendingTrust: PendingTrust | null = null;
  if (
    message &&
    activeAccountId &&
    message.signerFingerprint &&
    message.signatureState &&
    DECIDABLE.has(message.signatureState as DecidableSignatureState) &&
    message.id !== dismissedTrustMsgId
  ) {
    const state = message.signatureState as DecidableSignatureState;
    // Map the granular crypto outcome into a one-line chain context string
    // for the dialog body. Keeps the dialog self-contained without plumbing
    // `chainValid` through MailMessage (not currently mapped).
    let chainInfo = '';
    if (state === 'valid-unverified') {
      chainInfo = 'Signature valid; chain roots are not in your trust anchor set.';
    } else if (state === 'unknown-key') {
      chainInfo = "Signer's certificate is not in your keyring.";
    } else if (state === 'mismatch') {
      chainInfo = 'Signer identity does not match the message From header.';
    }
    pendingTrust = {
      accountId: activeAccountId,
      messageId: message.id,
      signerEmail: message.signerEmail ?? null,
      signerFingerprint: message.signerFingerprint,
      signatureState: state,
      chainInfo,
    };
  }

  // After a successful 'verified' write, clear the session plaintext cache for
  // the message and re-open the thread. The cache eviction forces the
  // selectThread crypto path to re-run `openCryptoMessage` (instead of taking
  // the cache-hit branch that only reads the STALE `message_crypto_results`
  // row). The re-open crypto pipeline consults `resolve_signer_trust`
  // (`mail/crypto.rs:312`), which now sees the fresh `verified` decision and
  // emits `signatureState=valid-verified` — so the dialog unmounts (state no
  // longer decidably-unverified) and the CryptoBadge flips to the success
  // glyph.
  const handleTrustResolved = () => {
    const msgId = pendingTrust?.messageId;
    const thread = selectedThread;
    setDismissedTrustMsgId(undefined);
    if (msgId) {
      // Evict just this message's cached plaintext so re-selectThread goes
      // through openCryptoMessage (cache-miss branch). We build a NEW object
      // so Zustand sees a state change.
      const cache = useViewStore.getState().decryptedCache;
      if (Object.prototype.hasOwnProperty.call(cache, msgId)) {
        const next = { ...cache };
        delete next[msgId];
        useViewStore.setState({ decryptedCache: next });
      }
    }
    if (thread) {
      void useThreadStore.getState().selectThread(thread);
    }
  };
  const handleTrustCancel = () => {
    // Suppress the dialog for this message until the user navigates away and
    // back. (Triggered by Escape/backdrop, the "Don't trust" button — which
    // already wrote a 'rejected' row — and any future explicit close action.)
    setDismissedTrustMsgId(pendingTrust?.messageId ?? activeMsgId);
  };

  // Inline `cid:` image resolution. When the selected message changes, fetch
  // its inline Content-ID parts in ONE round-trip and build a cid → data: URL
  // map that EmailRenderer substitutes into the HTML (before the remote-image
  // block, so inline images render without the "Load images" toggle). The map
  // is reset at render time above (on message change); this effect only fetches
  // and calls setState from the async callback (lint-allowed).
  useEffect(() => {
    const id = message?.id;
    const acct = activeAccountId;
    if (!id || !acct) return;
    // Gate: skip the full-message IMAP fetch (`BODY.PEEK[]`) unless the body
    // actually contains inline `cid:` image references. Without this, EVERY
    // selection triggers a full-message download — even for plain-text messages
    // with no inline images — because `fetchInlineImages` opens a new connection
    // + fetches the entire message just to check for CID parts.
    const body = message?.html;
    if (!body || !/\bcid:/i.test(body)) {
      // Clear any stale cidMap from a prior message. Deferred (not synchronous
      // in the effect body) to satisfy react-hooks/set-state-in-effect; the
      // cancelled guard prevents a post-unmount update.
      let cancelled = false;
      Promise.resolve().then(() => {
        if (!cancelled) setCidMap(new Map());
      });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    fetchInlineImages(acct, id)
      .then(async (parts) => {
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const p of parts) {
          try {
            // Read the cached file → Blob → object URL. Avoids base64 in the
            // HTML (Blob URL, not data:) AND avoids the finicky asset-protocol
            // (convertFileSrc scope/URL-format issues on Windows). The fs
            // plugin's appData scope already covers the attachment-cache dir.
            const bytes = await readFile(p.filePath);
            const blob = new Blob([bytes], { type: p.mimeType });
            m.set(p.contentId, URL.createObjectURL(blob));
          } catch (e) {
            console.error('[reading-pane] failed to load inline image', p.filePath, e);
          }
        }
        setCidMap(m);
      })
      .catch((e) => console.error('[reading-pane] fetchInlineImages failed', e));
    return () => {
      cancelled = true;
    };
  }, [message?.id, message?.html, activeAccountId]);

  // Calendar-invite detection: parse any text/calendar attachment whose METHOD
  // is REQUEST and render an RSVP card above the message body.
  useEffect(() => {
    const id = message?.id;
    const acct = activeAccountId;
    if (!id || !acct) return;
    let cancelled = false;
    getAttachments(acct, id)
      .then(async (rows) => {
        if (cancelled) return;
        const calendarRows = rows.filter((r) =>
          r.mimeType?.toLowerCase().startsWith('text/calendar'),
        );
        const events: ParsedEvent[] = [];
        for (const row of calendarRows) {
          try {
            const partId = row.imapPartId ?? row.id;
            const fetched = await fetchAttachment(acct, id, partId);
            const decoded = await readTextFile(fetched.filePath);
            const parsed = IcalHelper.parseEvents(decoded);
            events.push(...parsed.filter((ev) => ev.method === 'REQUEST'));
          } catch (e) {
            console.error('[reading-pane] failed to parse calendar attachment', row.id, e);
          }
        }
        setInviteEvents(events);
      })
      .catch((e) => {
        console.error('[reading-pane] getAttachments failed', e);
        setInviteEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [message?.id, activeAccountId]);

  if (!message) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-surface-elevated min-w-0 text-[var(--muted-text)]">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-floating)] text-[var(--muted-text)]">
            <MailIcon size={24} />
          </div>
          <p className="text-lg font-medium text-[var(--foreground)]">No message selected</p>
          <p className="mt-1 text-sm">Select a message from the list to read it here.</p>
        </div>
        <InjectedComponentSet
          role="reading-pane:footer"
          containersRequired={false}
          message={message}
          accountId={activeAccountId}
        />
      </div>
    );
  }

  // Inline reply / forward (Outlook-style) takes over the reading pane.
  if (inlineReplyMode) {
    return (
      <InlineReply
        message={message}
        mode={inlineReplyMode}
        accountId={activeAccountId}
        accountEmail={accountEmail}
        onClose={() => setInlineReplyMode(null)}
        onSent={() => setInlineReplyMode(null)}
      />
    );
  }

  const handleReply = () => setInlineReplyMode('reply');
  const handleReplyAll = () => setInlineReplyMode('replyAll');
  const handleForward = () => setInlineReplyMode('forward');

  async function handleAddContact() {
    if (!message) return;
    const name = message.from.name === message.from.address ? null : message.from.name;
    await upsertContact(message.from.address, name);
    setContactAdded(true);
    window.setTimeout(() => setContactAdded(false), 2000);
  }

  const isSuspicious = message.subject?.toLowerCase().includes('verify your account') ?? false;

  const level = message.classificationId ? getLevelById(message.classificationId) : undefined;
  const prominent = level ? isProminent(level) : false;

  // G6 Task 4: crypto badge hoist. The granular CryptoBadge (signature /
  // decrypt / revocation state) is shown for ANY encrypted or signed message,
  // INDEPENDENT of the `level` classification gate. Encrypted mail with no
  // classification level must still surface its badge. The legacy boolean
  // SecurityChips stays inside the classification row below for parity with
  // the message-list rows (where only the booleans are available).
  const isCryptoMessage = message.isEncrypted || message.isSigned;

  // G6 Task 4: decrypt-failure gate. When decryption could not produce
  // plaintext (`no-key` = no matching private key in keyring; `failed` =
  // decrypt attempted but errored), the body region renders a centered
  // status panel instead of EmailRenderer/AttachmentList. All other states
  // (`ok`, `n/a`, or undefined for non-crypto mail) fall through to the
  // normal body path.
  const decryptFailed = message.decryptState === 'no-key' || message.decryptState === 'failed';

  return (
    <div className="reading-pane relative flex h-full min-w-0 flex-col bg-surface-elevated border-l border-[var(--border-subtle)] shadow-sm">
      {prominent && level && <ClassificationBanner level={level} position="top" />}

      {isCryptoMessage && (
        <div
          className="reading-pane-crypto-row mt-2 flex items-center gap-2 px-5 pt-4"
          data-testid="reading-pane-crypto-row"
        >
          {/* Clickable for ANY crypto message (encrypted or signed). For
           * signed mail the dialog shows the signer cert + chain; for
           * encrypted-not-signed it shows the decrypt state + "not signed"
           * (signer is null — no re-parseable SignedData in the DB). */}
          <CryptoBadge
            signatureState={message.signatureState}
            decryptState={message.decryptState}
            revocationState={message.revocationState}
            signerEmail={message.signerEmail}
            signerFingerprint={message.signerFingerprint}
            variant="label"
            onShowDetails={() => setShowSignatureDetails(true)}
          />
        </div>
      )}

      {level && (
        <div
          className={`reading-pane-classification-row mt-2 flex items-center gap-2 px-5 ${
            isCryptoMessage ? 'pt-2' : 'pt-4'
          }`}
        >
          <ClassificationBadge level={level} />
          <SecurityChips
            isEncrypted={message.isEncrypted}
            isSigned={message.isSigned}
            variant="label"
          />
          {message.preventCopy && (
            <span className="text-[11px] text-[var(--muted-text)]">Prevent Copy</span>
          )}
          {message.readReceiptRequested && (
            <span className="text-[11px] text-[var(--muted-text)]">Read Receipt</span>
          )}
        </div>
      )}

      <MessageHeader
        message={message}
        extraActions={
          <InjectedComponentSet
            role="reading-pane:actions"
            containersRequired={false}
            message={message}
            accountId={activeAccountId}
          />
        }
        onReply={handleReply}
        onReplyAll={handleReplyAll}
        onForward={handleForward}
        onArchive={() => {
          if (!selectedThread) return;
          void archiveThread(selectedThread);
        }}
        onDelete={() => {
          if (!selectedThread) return;
          void trashThread(selectedThread);
        }}
        onJunk={() => {
          if (!selectedThread) return;
          void junkThread(selectedThread);
        }}
        onMarkUnread={() => {
          if (!selectedThread) return;
          void markThreadRead(selectedThread, false);
        }}
        onAddContact={handleAddContact}
        contactAdded={contactAdded}
      />

      <main
        className="relative flex-1 overflow-auto p-5 leading-[1.6] text-[var(--text)]"
        style={message.preventCopy ? { userSelect: 'none' } : undefined}
        onContextMenu={message.preventCopy ? (e) => e.preventDefault() : undefined}
      >
        {prominent && level && <ClassificationWatermark level={level} identity={accountEmail} />}
        {decryptFailed ? (
          <DecryptFailurePanel
            decryptState={message.decryptState}
            onManageKeys={() => openPreferences('Security')}
          />
        ) : (
          <>
            {inviteEvents.length > 0 && activeAccountId && accountEmail && (
              <div className="mb-4 flex flex-col gap-3">
                {inviteEvents.map((ev) => (
                  <RsvpCard
                    key={ev.uid}
                    event={ev}
                    accountId={activeAccountId}
                    accountEmail={accountEmail}
                    accountDisplayName={accountDisplayName}
                  />
                ))}
              </div>
            )}
            <AttachmentList
              accountId={activeAccountId}
              messageId={message.id}
              bodyHtml={message.html}
            />
            <div
              style={{
                transform: `scale(${readerZoom})`,
                transformOrigin: 'top left',
                width: `${100 / readerZoom}%`,
              }}
            >
              <EmailRenderer
                html={message.html}
                text={message.text}
                blockImages={!automaticallyLoadImages}
                senderAddress={message.from.address}
                accountId={activeAccountId}
                senderAllowlisted={false}
                isMessageSuspicious={isSuspicious}
                cidMap={cidMap}
              />
            </div>
          </>
        )}
      </main>
      {prominent && level && <ClassificationBanner level={level} position="bottom" />}
      <InjectedComponentSet
        role="reading-pane:footer"
        containersRequired={false}
        message={message}
        accountId={activeAccountId}
      />
      {pendingTrust && (
        <TrustDialog
          accountId={pendingTrust.accountId}
          messageId={pendingTrust.messageId}
          signerEmail={pendingTrust.signerEmail}
          signerFingerprint={pendingTrust.signerFingerprint}
          signatureState={pendingTrust.signatureState}
          chainInfo={pendingTrust.chainInfo}
          onResolved={handleTrustResolved}
          onCancel={handleTrustCancel}
        />
      )}
      {showSignatureDetails && isCryptoMessage && activeAccountId && (
        <SignatureDetailsDialog
          accountId={activeAccountId}
          messageId={message.id}
          onClose={() => setShowSignatureDetails(false)}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// G6 Task 4: decrypt-failure panel.
//
// Rendered in place of EmailRenderer/AttachmentList when the selected message
// is encrypted but the backend could not produce plaintext:
//   - `no-key` → no matching private key in the user's keyring
//   - `failed` → decrypt attempted but errored (CMS parse, padding, etc.)
//
// Stylistically mirrors the empty-state branch (centered icon + headline +
// sub-text + action). The action opens the Security preferences tab, which
// hosts the KeyManager section (key import / trust decisions).
// ──────────────────────────────────────────────────────────────────────────

interface DecryptFailurePanelProps {
  decryptState: 'no-key' | 'failed' | 'ok' | 'n/a' | undefined;
  onManageKeys: () => void;
}

function DecryptFailurePanel({ decryptState, onManageKeys }: DecryptFailurePanelProps) {
  const isNoKey = decryptState === 'no-key';
  const headline = isNoKey ? "Can't decrypt — no matching private key" : 'Decryption failed';
  const subtext = isNoKey
    ? 'This message was encrypted to a key that is not in your keyring. Import the matching private key to read it.'
    : 'The backend could not decrypt this message. The encrypted payload may be corrupted or use an unsupported algorithm.';
  return (
    <div
      data-testid="decrypt-failure-panel"
      className="flex h-full min-h-[280px] flex-col items-center justify-center px-6 py-10 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-floating)] text-[var(--amber)]">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 6.5-1.5" />
          <path d="M4 4l16 16" />
        </svg>
      </div>
      <p className="text-lg font-medium text-[var(--foreground)]">{headline}</p>
      <p className="mt-1 max-w-md text-sm text-[var(--muted-text)]">{subtext}</p>
      <button
        type="button"
        onClick={onManageKeys}
        className="mt-5 inline-flex h-9 items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-4 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--primary-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        Manage keys
      </button>
    </div>
  );
}
