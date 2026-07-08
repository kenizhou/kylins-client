import { useEffect, useState } from 'react';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { MailIcon } from '../icons';
import { useViewStore } from '../../features/view/viewStore';
import { useAccountStore } from '../../stores/accountStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useThreadStore } from '../../stores/threadStore';
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
import { IcalHelper, type ParsedEvent } from '../../services/calendar/icalHelper';

export function ReadingPane() {
  const message = useViewStore((s) => s.selectedMessage);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const account = activeAccountId ? (accounts.find((a) => a.id === activeAccountId) ?? null) : null;
  const accountEmail = account?.email ?? null;
  const accountDisplayName = account?.displayName ?? null;
  const automaticallyLoadImages = usePreferencesStore((s) => s.automaticallyLoadImages);
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
  }
  if (!message?.id && inviteEvents.length > 0) {
    setInviteEvents([]);
  }

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
      setCidMap(new Map());
      return;
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
  }, [message?.id, activeAccountId]);

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
      <div className="flex h-full flex-col items-center justify-center bg-[var(--card)] min-w-0 text-[var(--muted-text)]">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--muted-text)]">
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

  return (
    <div className="reading-pane relative flex h-full min-w-0 flex-col bg-[var(--card)]">
      {prominent && level && <ClassificationBanner level={level} position="top" />}

      {level && (
        <div className="reading-pane-classification-row mt-2 flex items-center gap-2 px-5 pt-4">
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
      </main>
      {prominent && level && <ClassificationBanner level={level} position="bottom" />}
      <InjectedComponentSet
        role="reading-pane:footer"
        containersRequired={false}
        message={message}
        accountId={activeAccountId}
      />
    </div>
  );
}
