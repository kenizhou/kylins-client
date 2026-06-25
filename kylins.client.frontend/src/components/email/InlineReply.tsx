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
import { EditorToolbar } from '@/components/composer/EditorToolbar';
import { buildComposerExtensions } from '@/features/composer/editorExtensions';
import { RecipientField } from '@/features/composer/RecipientField';
import { InputDialog } from '@/components/ui/InputDialog';
import { sendEmail } from '@/services/composer/send';
import { buildReplyQuote, buildForwardQuote } from '@/features/composer/prepareBodyForQuoting';
import {
  participantsForReply,
  participantsForReplyAll,
} from '@/features/composer/recipientsForReply';
import { subjectWithPrefix } from '@/features/composer/subjectPrefix';
import { applySignatureAboveQuote } from '@/features/composer/signaturePlacement';
import { resolveFromForReply } from '@/features/composer/fromResolution';
import type { Recipient } from '@/features/composer/contacts';
import { getDefaultSignature, type SignatureContext } from '@/services/db/signatures';
import {
  getAliasesForAccount,
  mapDbAlias,
  accountAsAlias,
  type SendAsAlias,
} from '@/services/db/sendAsAliases';
import { useAccountStore } from '@/stores/accountStore';
import { useComposerStore } from '@/stores/composerStore';
import { SendIcon, PopOutIcon } from '@/components/icons';
import type { MailMessage } from '@/features/view/viewStore';

type InlineMode = 'reply' | 'replyAll' | 'forward';

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
  const [showCcBcc, setShowCcBcc] = useState(initial.cc.length > 0);

  const [subject, setSubject] = useState(() =>
    subjectWithPrefix(message.subject, isForward ? 'Fwd:' : 'Re:'),
  );

  const [signature, setSignature] = useState<{ id: string; html: string } | null>(null);
  const [dbAliases, setDbAliases] = useState<SendAsAlias[]>([]);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [status, setStatus] = useState<SendStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const signatureContext: SignatureContext = mode === 'forward' ? 'forward' : 'reply';

  // Load the account's default signature + send-as aliases (for smart-From).
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    Promise.all([getDefaultSignature(accountId, signatureContext), getAliasesForAccount(accountId)]).then(
      ([sig, aliases]) => {
        if (cancelled) return;
        setSignature(sig ? { id: sig.id, html: sig.body_html } : null);
        setDbAliases(aliases.map(mapDbAlias));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Smart-From: pick the alias the message was addressed to (Mailspring
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

  // Seed the editor with the quoted original; place the signature above the
  // quote once it loads. useEditor reads `content` only at mount, so signature
  // arrival is pushed via setContent (guarded so it runs once per signature).
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
  const lastSigIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!editor) return;
    const sigId = signature?.id ?? 'none';
    if (lastSigIdRef.current === sigId) return;
    const prev = lastSigIdRef.current;
    lastSigIdRef.current = sigId;
    // Initial mount with no signature: the editor already holds baseQuote.
    if (prev === undefined && signature === null) return;
    const seeded = applySignatureAboveQuote(editor.getHTML(), signature);
    // emitUpdate: false so this programmatic seed doesn't loop back through onUpdate.
    editor.commands.setContent(seeded, { emitUpdate: false });
  }, [editor, signature]);

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
    const result = await sendEmail(accountId, {
      accountId,
      to: toRecipients,
      cc: ccRecipients.length > 0 ? ccRecipients : undefined,
      bcc: bccRecipients.length > 0 ? bccRecipients : undefined,
      subject,
      bodyHtml: editor.getHTML(),
      fromEmail: fromEmail ?? accountEmail ?? undefined,
      threadId: message.threadId ?? null,
      // A forward is a new branch of the conversation, not a reply, so it
      // carries no In-Reply-To header.
      inReplyToMessageId: isForward ? null : (message.messageId ?? null),
    });
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
    subject,
    fromEmail,
    accountEmail,
    message.threadId,
    message.messageId,
    isForward,
    onSent,
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
      subject,
      bodyHtml: editor?.getHTML() ?? '',
      threadId: message.threadId ?? null,
      inReplyToMessageId: isForward ? null : (message.messageId ?? null),
      fromEmail: fromEmail ?? accountEmail ?? undefined,
      signatureId: signature?.id ?? null,
    });
    onClose();
  }, [
    openComposer,
    mode,
    toRecipients,
    ccRecipients,
    bccRecipients,
    subject,
    editor,
    message.threadId,
    message.messageId,
    isForward,
    fromEmail,
    accountEmail,
    onClose,
  ]);

  const sentLabel = isForward ? 'Forward sent.' : 'Reply sent.';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--card)]">
      {/* Header: From (only when smart-From picked a non-default alias), To/Cc/Bcc, Subject */}
      <div className="border-b border-[var(--border)] px-4 py-2 text-xs">
        {fromEmail && fromEmail !== accountEmail && (
          <div className="mb-0.5 flex gap-2">
            <span className="w-8 shrink-0 text-[var(--muted-text)]">From</span>
            <span className="min-w-0 break-words text-[var(--foreground)]">{fromEmail}</span>
          </div>
        )}
        <RecipientField
          label="To"
          recipients={toRecipients}
          onChange={setToRecipients}
          placeholder="Recipients"
        />
        {showCcBcc ? (
          <div className="mt-1 space-y-1">
            <RecipientField
              label="Cc"
              recipients={ccRecipients}
              onChange={setCcRecipients}
              placeholder="Cc recipients"
            />
            <RecipientField
              label="Bcc"
              recipients={bccRecipients}
              onChange={setBccRecipients}
              placeholder="Bcc recipients"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCcBcc(true)}
            className="ml-10 mt-0.5 text-[var(--primary)] hover:opacity-80"
          >
            Cc / Bcc
          </button>
        )}
        <div className="mt-1 flex items-center gap-2">
          <span className="w-8 shrink-0 text-[var(--muted-text)]">Sub</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none"
          />
        </div>
      </div>

      <EditorToolbar editor={editor} onRequestLink={() => setShowLinkDialog(true)} />

      <div className="kylins-editor-scroll flex-1 overflow-auto">
        <EditorContent editor={editor} />
      </div>

      {/* Send bar */}
      <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePopOut}
            title="Pop out to window"
            aria-label="Pop out to window"
            className="rounded p-1 text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)]"
          >
            <PopOutIcon size={14} />
          </button>
          <div className="min-h-4 text-xs">
            {status === 'error' && errorMsg && (
              <span className="text-[var(--destructive)]">{errorMsg}</span>
            )}
            {status === 'sent' && <span className="text-[var(--green)]">{sentLabel}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={status === 'sending'}
            className="flex items-center gap-1.5 rounded bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SendIcon size={12} />
            {status === 'sending' ? 'Sending…' : 'Send'}
          </button>
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
