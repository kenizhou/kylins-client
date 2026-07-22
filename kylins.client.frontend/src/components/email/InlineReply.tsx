// Inline reply / forward composer (Outlook/Mailspring-style): renders inside
// the reading pane so the user can reply or forward without opening the modal
// composer. Shares the Mailspring-faithful quoting + recipient + signature
// modules with the modal composer (src/features/composer/*) and the full send
// pipeline (services/composer/send).
//
// A "pop out to modal composer" affordance (like Mailspring's inline editor) is
// planned and will give the modal its reply/forward entry point.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Button, Input, TextField, Checkbox } from 'react-aria-components';
import { EditorToolbar } from '@/components/composer/EditorToolbar';
import { buildComposerExtensions } from '@/features/composer/editorExtensions';
import { RecipientField } from '@/features/composer/RecipientField';
import { InputDialog } from '@/components/ui/InputDialog';
import { sendEmail } from '@/services/composer/send';
import { stageAttachment, newDraftId } from '@/services/composer/attachments';
import {
  getAttachments,
  fetchAttachment,
  fetchInlineImages,
  cachedImageToDataUrl,
} from '@/services/db/attachments';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { ComposerAttachment } from '@/stores/composerStore';
import { buildReplyQuote, buildForwardQuote } from '@/features/composer/prepareBodyForQuoting';
import {
  participantsForReply,
  participantsForReplyAll,
} from '@/features/composer/recipientsForReply';
import { subjectWithPrefix } from '@/features/composer/subjectPrefix';
import { resolveFromForReply } from '@/features/composer/fromResolution';
import { useComposerSignature } from '@/features/composer/useComposerSignature';
import { getActiveSignatureId } from '@/features/composer/signatureCommands';
import { SignatureSelector } from '@/components/composer/SignatureSelector';
import type { Recipient } from '@/features/composer/contacts';
import {
  getAliasesForAccount,
  mapDbAlias,
  accountAsAlias,
  type SendAsAlias,
} from '@/services/db/sendAsAliases';
import { useAccountStore } from '@/stores/accountStore';
import { useComposerStore } from '@/stores/composerStore';
import { usePreferencesStore } from '@/stores/preferencesStore';
import { SendIcon, PopOutIcon, CloseIcon } from '@/components/icons';
import type { MailMessage } from '@/features/view/viewStore';

type InlineMode = 'reply' | 'replyAll' | 'forward';

function newAttachmentId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface InlineReplyProps {
  message: MailMessage;
  mode: InlineMode;
  accountId: string | null;
  accountEmail: string | null;
  onClose: () => void;
  onSent: () => void;
}

type SendStatus = 'idle' | 'sending' | 'sent' | 'error';

export function InlineReply({
  message,
  mode,
  accountId,
  accountEmail,
  onClose,
  onSent,
}: InlineReplyProps) {
  const isForward = mode === 'forward';
  const selfEmails = accountEmail ? [accountEmail] : [];

  // Recipients are pre-filled for replies (To/Cc via participantsForReply*),
  // empty for forward. The component remounts per message/mode (ReadingPane
  // unmounts it when composeMode clears), so lazy initializers are correct.
  const initial = useMemo<{ to: Recipient[]; cc: Recipient[] }>(() => {
    if (mode === 'forward') return { to: [], cc: [] };
    if (mode === 'replyAll') return participantsForReplyAll(message, selfEmails);
    return { ...participantsForReply(message, selfEmails), cc: [] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [toRecipients, setToRecipients] = useState<Recipient[]>(initial.to);
  const [ccRecipients, setCcRecipients] = useState<Recipient[]>(initial.cc);
  const [bccRecipients, setBccRecipients] = useState<Recipient[]>([]);
  const [replyToRecipients, setReplyToRecipients] = useState<Recipient[]>([]);
  const [includeOriginalAttachments, setIncludeOriginalAttachments] = useState(true);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  // Single stagingDraftId for the component's lifetime: pick-time staging,
  // forward-seed staging, and send-time SendDraft.draftId all share this id so
  // backend cleanup (<appData>/outbox-attachments/{draftId}/) targets the right
  // dir. Previously the forward-seed effect generated its own id and sendEmail
  // generated yet another → staged files leaked.
  const [stagingDraftId] = useState(() => newDraftId());
  const attachmentSeededRef = useRef(false);
  const inlineImagesSeededRef = useRef(false);
  const alwaysShowCcBcc = usePreferencesStore((s) => s.alwaysShowCcBcc);
  const [ccExpanded, setCcExpanded] = useState(() => initial.cc.length > 0 || alwaysShowCcBcc);
  const [bccExpanded, setBccExpanded] = useState(() => alwaysShowCcBcc);
  const [replyToExpanded, setReplyToExpanded] = useState(() => alwaysShowCcBcc);
  const showCc = ccExpanded || alwaysShowCcBcc || ccRecipients.length > 0;
  const showBcc = bccExpanded || alwaysShowCcBcc || bccRecipients.length > 0;
  const showReplyTo = replyToExpanded || alwaysShowCcBcc || replyToRecipients.length > 0;

  const handleAddressBlockBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (alwaysShowCcBcc) return;
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (ccRecipients.length === 0) setCcExpanded(false);
    if (bccRecipients.length === 0) setBccExpanded(false);
    if (replyToRecipients.length === 0) setReplyToExpanded(false);
  };

  const [subject, setSubject] = useState(() =>
    subjectWithPrefix(message.subject, isForward ? 'Fwd:' : 'Re:'),
  );

  const [dbAliases, setDbAliases] = useState<SendAsAlias[]>([]);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [status, setStatus] = useState<SendStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load the account's send-as aliases (for smart-From).
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    getAliasesForAccount(accountId).then((aliases) => {
      if (cancelled) return;
      setDbAliases(aliases.map(mapDbAlias));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Seed forwarded original-message attachments as file-backed refs. Inline
  // images are intentionally re-attached as files rather than preserved as CID
  // references, matching the modal composer forward path.
  useEffect(() => {
    if (!isForward || !accountId || !message.messageId || !includeOriginalAttachments) {
      attachmentSeededRef.current = false;
      return;
    }
    if (attachmentSeededRef.current) return;

    const messageId = message.messageId!;
    const accountId_ = accountId!;
    let cancelled = false;
    async function seed() {
      attachmentSeededRef.current = true;
      try {
        const rows = await getAttachments(accountId_, messageId);
        const seeded: ComposerAttachment[] = [];
        for (const row of rows) {
          if (cancelled) return;
          const partId = row.imapPartId || row.id;
          // sync_fetch_attachment returns a cached file path (no base64
          // over IPC). Copy the cached file into the draft outbox.
          const fetched = await fetchAttachment(accountId_, messageId, partId);
          if (cancelled) return;
          const destPath = await stageAttachment(
            stagingDraftId,
            fetched.filePath,
            row.filename || 'attachment',
          );
          seeded.push({
            id: newAttachmentId(),
            filename: row.filename || 'attachment',
            mimeType: fetched.mimeType || row.mimeType || 'application/octet-stream',
            size: row.size,
            filePath: destPath,
          });
        }
        if (!cancelled) setAttachments((prev) => [...prev, ...seeded]);
      } catch (err) {
        console.error('[InlineReply] failed to seed original attachments', err);
      }
    }
    seed();
    return () => {
      cancelled = true;
    };
  }, [isForward, accountId, message.messageId, includeOriginalAttachments, stagingDraftId]);

  // Attach-button bridge: while an inline reply is open, the main window's
  // CommandRibbon flips to compose mode (driven by viewStore.inlineReplyMode),
  // so its Attach button is reachable. ComposeRibbon dispatches the
  // `composer:attach-requested` window event; this listener mirrors the modal
  // Composer's handleAttachRequested (Composer.tsx) — opens the OS file picker,
  // stages each picked file via the backend `stage_picked_attachment` command
  // into this reply's stagingDraftId outbox dir, and adds a chip.
  useEffect(() => {
    const handleAttachRequested = async () => {
      try {
        const selected = await open({ multiple: true });
        if (!selected) return;
        const paths = Array.isArray(selected) ? selected : [selected];
        if (paths.length === 0) return;
        for (const path of paths) {
          const filename = path.split(/[\\/]/).pop() ?? path;
          const staged = await invoke<{ filePath: string; mimeType: string; size: number }>(
            'stage_picked_attachment',
            { srcPath: path, draftId: stagingDraftId, filename },
          );
          setAttachments((prev) => [
            ...prev,
            {
              id: newAttachmentId(),
              filename,
              mimeType: staged.mimeType,
              size: staged.size,
              filePath: staged.filePath,
            },
          ]);
        }
      } catch (err) {
        console.error('[InlineReply] attach pick failed', err);
      }
    };
    window.addEventListener('composer:attach-requested', handleAttachRequested);
    return () => window.removeEventListener('composer:attach-requested', handleAttachRequested);
  }, [stagingDraftId]);

  // _fromContactForReply). Falls back to the account address.
  const accounts = useAccountStore((s) => s.accounts);
  const openComposer = useComposerStore((s) => s.openComposer);
  const fromEmail = useMemo(() => {
    const fallback = accountEmail ?? undefined;
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return fallback;
    const seen = new Set<string>();
    const merged = [accountAsAlias(account), ...dbAliases].filter((a) => {
      const key = a.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const defaultAlias = merged.find((a) => a.isDefault) ?? merged[0];
    if (!defaultAlias || merged.length <= 1) return defaultAlias?.email ?? fallback;
    return resolveFromForReply(message, merged, defaultAlias).email;
  }, [accounts, accountId, accountEmail, dbAliases, message]);

  // Seed the editor with the quoted original; the signature is a dedicated
  // block applied by the shared hook below (document is the source of truth).
  const baseQuote = useMemo(
    () => (isForward ? buildForwardQuote(message) : buildReplyQuote(message)),
    [isForward, message],
  );
  const editor = useEditor({
    extensions: buildComposerExtensions(
      isForward ? 'Add a note to the forwarded message…' : 'Type your reply…',
    ),
    content: baseQuote,
    editorProps: {
      attributes: {
        class:
          'kylins-editor max-w-none px-4 py-3 min-h-[120px] focus:outline-none text-[var(--foreground)]',
      },
    },
  });

  // Signature block: loads the account default for reply/forward, swaps it as
  // a dedicated editor block when the user picks another. The document is the
  // source of truth — send/pop-out read signature.activeId directly.
  const signature = useComposerSignature(editor, accountId, mode);
  const { setSignature } = signature;

  // Forward inline images: fetch Content-ID parts and rewrite the quoted body
  // so inline images render as data URLs. The send pipeline converts them back
  // to CID attachments. Guarded by ref so user edits are not overwritten.
  useEffect(() => {
    if (!isForward || !accountId || !message.messageId) return;
    if (inlineImagesSeededRef.current) return;
    inlineImagesSeededRef.current = true;

    const messageId = message.messageId!;
    const accountId_ = accountId!;
    let cancelled = false;
    async function seed() {
      try {
        const parts = await fetchInlineImages(accountId_, messageId);
        if (cancelled || parts.length === 0) return;
        // Forward path: the send pipeline's `extractInlineImages` matches
        // `data:` URLs to re-attach inline images as CID parts, so we read
        // each cached file into a data URL here (not convertFileSrc).
        const cidMap = new Map<string, string>();
        for (const p of parts) {
          cidMap.set(p.contentId, await cachedImageToDataUrl(p.filePath, p.mimeType));
        }
        const html = buildForwardQuote(message, cidMap);
        // Read the active signature from the doc (not a closure variable) so a
        // signature change made while the images loaded is preserved; then
        // re-apply it after setContent rebuilds the quote.
        const sigIdToRestore = editor ? getActiveSignatureId(editor.state.doc) : null;
        editor?.commands.setContent(html, { emitUpdate: false });
        if (sigIdToRestore) setSignature(sigIdToRestore);
      } catch (err) {
        console.error('[InlineReply] failed to seed inline images', err);
      }
    }
    seed();
    return () => {
      cancelled = true;
    };
  }, [isForward, accountId, message.messageId, message, editor, setSignature]);

  // Smart-From: pick the alias the message was addressed to (Mailspring
  // _fromContactForReply). Falls back to the account address.
  const handleSend = useCallback(async () => {
    if (!editor || status === 'sending') return;
    if (!accountId) {
      setStatus('error');
      setErrorMsg('No account configured to send from.');
      return;
    }
    if (toRecipients.length === 0) {
      setStatus('error');
      setErrorMsg('Add at least one recipient.');
      return;
    }
    setStatus('sending');
    setErrorMsg(null);
    const result = await sendEmail(
      accountId,
      {
        accountId,
        to: toRecipients,
        cc: ccRecipients.length > 0 ? ccRecipients : undefined,
        bcc: bccRecipients.length > 0 ? bccRecipients : undefined,
        replyTo: replyToRecipients.length > 0 ? replyToRecipients : undefined,
        subject,
        bodyHtml: editor.getHTML(),
        fromEmail: fromEmail ?? accountEmail ?? undefined,
        threadId: message.threadId ?? null,
        // A forward is a new branch of the conversation, not a reply, so it
        // carries no In-Reply-To header.
        inReplyToMessageId: isForward ? null : (message.messageId ?? null),
        classificationId: message.classificationId,
        isEncrypted: message.isEncrypted,
        isSigned: message.isSigned,
        signatureId: signature.activeId,
        attachments:
          attachments.length > 0
            ? attachments.map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                filePath: a.filePath,
                size: a.size,
              }))
            : undefined,
      },
      stagingDraftId,
    );
    if (result.success) {
      setStatus('sent');
      onSent();
    } else {
      setStatus('error');
      setErrorMsg(result.message);
    }
  }, [
    editor,
    status,
    accountId,
    toRecipients,
    ccRecipients,
    bccRecipients,
    replyToRecipients,
    subject,
    attachments,
    fromEmail,
    accountEmail,
    message.threadId,
    message.messageId,
    isForward,
    onSent,
    stagingDraftId,
    signature.activeId,
  ]);

  // Pop out to the full modal composer (Mailspring-style), carrying the inline
  // state. The modal seeds its editor from bodyHtml, which already carries the
  // quoted original + signature.
  const handlePopOut = useCallback(() => {
    openComposer({
      mode,
      to: toRecipients,
      cc: ccRecipients.length > 0 ? ccRecipients : undefined,
      bcc: bccRecipients.length > 0 ? bccRecipients : undefined,
      replyTo: replyToRecipients.length > 0 ? replyToRecipients : undefined,
      subject,
      bodyHtml: editor?.getHTML() ?? '',
      threadId: message.threadId ?? null,
      inReplyToMessageId: isForward ? null : (message.messageId ?? null),
      fromEmail: fromEmail ?? accountEmail ?? undefined,
      // Three-state: null = explicitly removed (pop-out must not re-add the
      // default); undefined = hook not ready yet (pop-out applies default).
      signatureId: signature.ready ? signature.activeId : undefined,
      classificationId: message.classificationId,
      isEncrypted: message.isEncrypted,
      isSigned: message.isSigned,
      originalMessageId: message.messageId ?? null,
      includeOriginalAttachments: isForward ? true : undefined,
    });
    onClose();
  }, [
    openComposer,
    mode,
    toRecipients,
    ccRecipients,
    bccRecipients,
    replyToRecipients,
    subject,
    editor,
    message.threadId,
    message.messageId,
    isForward,
    fromEmail,
    accountEmail,
    onClose,
    signature.ready,
    signature.activeId,
  ]);

  const sentLabel = isForward ? 'Forward sent.' : 'Reply sent.';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--card)]">
      {/* Header: From, To/Cc/Bcc/Reply-To toggles, Subject */}
      <div className="border-b border-[var(--border)] px-4 py-2 text-xs">
        <div className="mb-0.5 flex items-start gap-2">
          {fromEmail && fromEmail !== accountEmail && (
            <div className="flex flex-1 min-w-0 gap-2">
              <span className="w-8 shrink-0 text-[var(--muted-text)]">From</span>
              <span className="min-w-0 break-words text-[var(--foreground)]">{fromEmail}</span>
            </div>
          )}
          {!alwaysShowCcBcc && (
            <div className="flex items-center gap-2 text-[var(--muted-text)]">
              <span className="text-[var(--border)]" aria-hidden="true">
                |
              </span>
              {!showCc && (
                <Button
                  type="button"
                  onPress={() => setCcExpanded(true)}
                  className="kylins-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Cc
                </Button>
              )}
              {!showBcc && (
                <Button
                  type="button"
                  onPress={() => setBccExpanded(true)}
                  className="kylins-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Bcc
                </Button>
              )}
              {!showReplyTo && (
                <Button
                  type="button"
                  onPress={() => setReplyToExpanded(true)}
                  className="kylins-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  &gt;&gt;
                </Button>
              )}
            </div>
          )}
        </div>
        <RecipientField
          label="To"
          recipients={toRecipients}
          onChange={setToRecipients}
          placeholder="Recipients"
        />
        {(showCc || showBcc || showReplyTo || alwaysShowCcBcc) && (
          <div className="mt-1 space-y-1" onBlur={handleAddressBlockBlur}>
            {showCc && (
              <RecipientField
                label="Cc"
                recipients={ccRecipients}
                onChange={setCcRecipients}
                placeholder="Cc recipients"
              />
            )}
            {showBcc && (
              <RecipientField
                label="Bcc"
                recipients={bccRecipients}
                onChange={setBccRecipients}
                placeholder="Bcc recipients"
              />
            )}
            {showReplyTo && (
              <RecipientField
                label="Reply-To"
                recipients={replyToRecipients}
                onChange={setReplyToRecipients}
                placeholder="Reply-To address"
              />
            )}
          </div>
        )}
        <div className="mt-1 flex items-center gap-2">
          <span className="w-8 shrink-0 text-[var(--muted-text)]">Sub</span>
          <TextField className="min-w-0 flex-1" aria-label="Subject">
            <Input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full bg-transparent text-[var(--foreground)] outline-none"
            />
          </TextField>
        </div>
      </div>

      <EditorToolbar editor={editor} onRequestLink={() => setShowLinkDialog(true)} />

      <div className="kylins-editor-scroll flex-1 overflow-auto">
        <EditorContent editor={editor} />
      </div>

      {/* Attachments — mirrors the modal Composer layout (below editor, above
          footer) so inline reply and popout composer stay visually consistent. */}
      <div className="border-t border-[var(--border)]">
        {isForward && (
          <div className="flex items-center gap-2 px-4 py-1.5">
            <Checkbox
              isSelected={includeOriginalAttachments}
              onChange={(selected) => {
                setIncludeOriginalAttachments(selected);
                if (!selected) {
                  setAttachments([]);
                  attachmentSeededRef.current = false;
                }
              }}
              className="flex items-center gap-2 text-[var(--foreground)]"
            >
              <span className="text-xs">Include original attachments</span>
            </Checkbox>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-1.5">
            {attachments.map((att) => (
              <span
                key={att.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
              >
                <span className="max-w-[150px] truncate">{att.filename}</span>
                <Button
                  type="button"
                  onPress={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                  className="text-[var(--muted-text)] outline-none hover:text-[var(--foreground)] focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={`Remove ${att.filename}`}
                >
                  <CloseIcon size={12} />
                </Button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Send bar */}
      <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onPress={handlePopOut}
            aria-label="Pop out to window"
            className="rounded p-1 text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <PopOutIcon size={14} />
          </Button>
          <SignatureSelector
            signatures={signature.signatures}
            activeId={signature.activeId}
            onSelect={signature.setSignature}
            disabled={!signature.ready}
          />
          <div className="min-h-4 text-xs">
            {status === 'error' && errorMsg && (
              <span className="text-[var(--destructive)]">{errorMsg}</span>
            )}
            {status === 'sent' && <span className="text-[var(--green)]">{sentLabel}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onPress={onClose}
            className="rounded px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Discard
          </Button>
          <Button
            type="button"
            onPress={handleSend}
            isDisabled={status === 'sending'}
            className="flex items-center gap-1.5 rounded bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SendIcon size={12} />
            {status === 'sending' ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>

      <InputDialog
        isOpen={showLinkDialog}
        onClose={() => setShowLinkDialog(false)}
        onSubmit={(values) => {
          if (values.url) editor?.chain().focus().setLink({ href: values.url }).run();
        }}
        title="Insert Link"
        fields={[{ key: 'url', label: 'URL', placeholder: 'https://...' }]}
        submitLabel="Insert"
      />
    </div>
  );
}
