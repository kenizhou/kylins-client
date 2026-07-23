// Docked inline reply / forward composer (Outlook-style): renders at the top
// of the reading pane with the original message visible below. All draft
// state lives in inlineComposerStore (survives message switches — see the
// store header); this component is just the editor surface:
//   - seeds the TipTap editor from session.bodyHtml (seed quote on open,
//     restored user edits when remounting after a message switch),
//   - mirrors edits back into the store (dirty tracking + pop-out payload),
//   - sends through the shared pipeline (services/composer/send).
//
// The dock renders a skeleton until the draftFactory seed resolves (aliases,
// recipients, quoted body, forward CID map are all settled pre-mount — no
// post-mount setContent, so typed text can never be wiped by seeding).

import { useCallback, useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Button, Input, TextField, Checkbox } from 'react-aria-components';
import { EditorToolbar } from '@/components/composer/EditorToolbar';
import { buildComposerExtensions } from '@/features/composer/editorExtensions';
import { RecipientField, type MoveTarget } from '@/features/composer/RecipientField';
import { eqEmail, type Recipient } from '@/features/composer/contacts';
import { InputDialog } from '@/components/ui/InputDialog';
import { sendEmail } from '@/services/composer/send';
import { newAttachmentId } from '@/services/composer/attachments';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { intentFamily } from '@/features/composer/draftFactory';
import { useComposerSignature } from '@/features/composer/useComposerSignature';
import { ClassificationSelector } from '@/features/composer/ClassificationSelector';
import { useInlineComposerStore, type InlineSession } from '@/stores/inlineComposerStore';
import { usePreferencesStore } from '@/stores/preferencesStore';
import { SendIcon, ExternalLinkIcon, DiscardIcon, CloseIcon } from '@/components/icons';

type SendStatus = 'idle' | 'sending' | 'error';

/** Dock shell: skeleton while the seed resolves, editor surface after. */
export function InlineReply() {
  const session = useInlineComposerStore((s) => s.session);
  const discard = useInlineComposerStore((s) => s.discard);
  if (!session) return null;
  if (!session.seed) {
    return (
      <div
        className="flex h-full flex-col gap-2 bg-[var(--card)] px-4 py-3"
        role="status"
        aria-label="Preparing reply"
      >
        <div className="h-3 w-40 animate-pulse rounded bg-[var(--surface)]" />
        <div className="h-3 w-full animate-pulse rounded bg-[var(--surface)]" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--surface)]" />
        <div className="mt-2 h-24 w-full animate-pulse rounded bg-[var(--surface)]" />
        {session.seedError && (
          <div className="flex items-center gap-3">
            <p className="text-xs text-[var(--destructive)]">
              Failed to prepare the draft: {session.seedError}
            </p>
            <Button
              type="button"
              onPress={() => discard({ skipConfirm: true })}
              className="rounded px-2 py-1 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Discard
            </Button>
          </div>
        )}
      </div>
    );
  }
  return <InlineReplyEditor session={session} />;
}

function InlineReplyEditor({ session }: { session: InlineSession }) {
  const family = intentFamily(session.intent);
  const isForward = family === 'forward';

  const setTo = useInlineComposerStore((s) => s.setTo);
  const setCc = useInlineComposerStore((s) => s.setCc);
  const setBcc = useInlineComposerStore((s) => s.setBcc);
  const setSubject = useInlineComposerStore((s) => s.setSubject);
  const setBodyHtml = useInlineComposerStore((s) => s.setBodyHtml);
  const setSignatureId = useInlineComposerStore((s) => s.setSignatureId);
  const addAttachment = useInlineComposerStore((s) => s.addAttachment);
  const removeAttachment = useInlineComposerStore((s) => s.removeAttachment);
  const setIncludeOriginalAttachments = useInlineComposerStore(
    (s) => s.setIncludeOriginalAttachments,
  );
  const discard = useInlineComposerStore((s) => s.discard);
  const clearAfterSend = useInlineComposerStore((s) => s.clearAfterSend);
  const popOut = useInlineComposerStore((s) => s.popOut);

  const alwaysShowCcBcc = usePreferencesStore((s) => s.alwaysShowCcBcc);
  const [ccExpanded, setCcExpanded] = useState(() => session.cc.length > 0 || alwaysShowCcBcc);
  const [bccExpanded, setBccExpanded] = useState(() => alwaysShowCcBcc);
  const showCc = ccExpanded || alwaysShowCcBcc || session.cc.length > 0;
  const showBcc = bccExpanded || alwaysShowCcBcc || session.bcc.length > 0;

  const handleAddressBlockBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (alwaysShowCcBcc) return;
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (session.cc.length === 0) setCcExpanded(false);
    if (session.bcc.length === 0) setBccExpanded(false);
  };

  // Move a recipient chip between To/Cc/Bcc (mirrors the modal Composer).
  const handleMoveRecipient = useCallback(
    (recipient: Recipient, from: MoveTarget, toField: MoveTarget) => {
      if (from === 'replyTo' || toField === 'replyTo') return; // no Reply-To row inline
      const lists = { to: session.to, cc: session.cc, bcc: session.bcc } as const;
      const setters = { to: setTo, cc: setCc, bcc: setBcc } as const;
      setters[from](lists[from].filter((r) => !eqEmail(r.email, recipient.email)));
      if (!lists[toField].some((r) => eqEmail(r.email, recipient.email))) {
        setters[toField]([...lists[toField], recipient]);
      }
    },
    [session.to, session.cc, session.bcc, setTo, setCc, setBcc],
  );

  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [status, setStatus] = useState<SendStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Seed the editor from the session body (seed quote on first open, restored
  // edits when remounting after a message switch). Edits mirror back into the
  // store; `hasFocus` distinguishes user typing from programmatic transactions
  // (signature application) so only real edits clear the pristine flag.
  const editor = useEditor({
    extensions: buildComposerExtensions(
      isForward ? 'Add a note to the forwarded message…' : 'Type your reply…',
    ),
    content: session.bodyHtml ?? '',
    editorProps: {
      attributes: {
        class:
          'kylins-editor max-w-none px-4 py-3 min-h-[120px] focus:outline-none text-[var(--foreground)]',
      },
    },
    onUpdate: ({ editor: e }) => {
      setBodyHtml(e.getHTML(), { userEdit: e.view.hasFocus() });
    },
  });

  // Signature block: loads the account default for reply/forward, swaps it as
  // a dedicated editor block when the user picks another. The document is the
  // source of truth — send/pop-out read signature.activeId directly.
  const signature = useComposerSignature(editor, session.accountId, family, {
    initialSignatureId: session.signatureId,
    onChange: setSignatureId,
  });

  // Attach-button bridge: while the inline composer is visible, the main
  // window's CommandRibbon is in compose mode, so its Attach button is
  // reachable. ComposeRibbon dispatches the `composer:attach-requested`
  // window event; this listener opens the OS file picker and stages each
  // picked file into this session's outbox dir.
  useEffect(() => {
    const stagingDraftId = session.stagingDraftId;
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
          addAttachment({
            id: newAttachmentId(),
            filename,
            mimeType: staged.mimeType,
            size: staged.size,
            filePath: staged.filePath,
            origin: 'picked',
          });
        }
      } catch (err) {
        console.error('[InlineReply] attach pick failed', err);
      }
    };
    window.addEventListener('composer:attach-requested', handleAttachRequested);
    return () => window.removeEventListener('composer:attach-requested', handleAttachRequested);
  }, [session.stagingDraftId, addAttachment]);

  const handleSend = useCallback(async () => {
    if (!editor || status === 'sending') return;
    if (session.to.length === 0) {
      setStatus('error');
      setErrorMsg('Add at least one recipient.');
      return;
    }
    setStatus('sending');
    setErrorMsg(null);
    try {
      const result = await sendEmail(
        session.accountId,
        {
          accountId: session.accountId,
          to: session.to,
          cc: session.cc.length > 0 ? session.cc : undefined,
          bcc: session.bcc.length > 0 ? session.bcc : undefined,
          replyTo: session.replyTo.length > 0 ? session.replyTo : undefined,
          subject: session.subject,
          bodyHtml: editor.getHTML(),
          fromEmail: session.fromEmail ?? session.accountEmail,
          // Threading fields from the seed (a forward starts a new branch —
          // no In-Reply-To).
          threadId: session.threadId ?? session.message.threadId ?? null,
          inReplyToMessageId:
            session.inReplyToMessageId ?? (isForward ? null : (session.message.messageId ?? null)),
          classificationId: session.classificationId,
          isEncrypted: session.isEncrypted,
          isSigned: session.isSigned,
          importance: session.importance,
          requestReadReceipt: session.requestReadReceipt,
          requestDeliveryReceipt: session.requestDeliveryReceipt,
          deliverAt: session.deliverAt,
          preventCopy: session.preventCopy,
          signatureId: signature.activeId,
          attachments:
            session.attachments.length > 0
              ? session.attachments.map((a) => ({
                  filename: a.filename,
                  mimeType: a.mimeType,
                  filePath: a.filePath,
                  size: a.size,
                }))
              : undefined,
        },
        session.stagingDraftId,
      );
      if (result.success) {
        // The backend cleans the staging directory on send-success.
        clearAfterSend();
      } else {
        setStatus('error');
        setErrorMsg(result.message);
      }
    } catch (err) {
      // buildSendDraft failures (staging/backfill/inline-image extraction)
      // throw rather than returning a result — surface them instead of
      // wedging the dock in "Sending…".
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [editor, status, session, isForward, signature.activeId, clearAfterSend]);

  // Pop out to the full modal composer, handing over the staging directory
  // and attachments (no files re-copied or orphaned).
  const handlePopOut = useCallback(() => {
    popOut(
      editor?.getHTML() ?? session.bodyHtml ?? '',
      // Three-state: null = explicitly removed (pop-out must not re-add the
      // default); undefined = hook not ready yet (pop-out applies default).
      signature.ready ? signature.activeId : undefined,
    );
  }, [popOut, editor, session.bodyHtml, signature.ready, signature.activeId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--card)]">
      {/* Top action bar: Send + status left, Discard / Pop out right */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onPress={handleSend}
            isDisabled={status === 'sending'}
            className="flex items-center gap-1.5 rounded bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SendIcon size={12} />
            {status === 'sending' ? 'Sending…' : 'Send'}
          </Button>
          <div className="min-h-4 text-xs">
            {status === 'error' && errorMsg && (
              <span className="text-[var(--destructive)]">{errorMsg}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onPress={() => discard()}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <DiscardIcon size={12} />
            Discard
          </Button>
          <Button
            type="button"
            onPress={handlePopOut}
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <ExternalLinkIcon size={12} />
            Pop out
          </Button>
        </div>
      </div>

      {/* Classification banner — slim full-width strip (mirrors the modal
          Composer); binds to this inline session via useActiveComposerTarget. */}
      <ClassificationSelector />

      {/* Address block: From (aliases), To with trailing Cc/Bcc toggles
          (mirrors the modal Composer), Subject */}
      <div className="border-b border-[var(--border)] px-4 py-2 text-xs">
        {session.fromEmail && session.fromEmail !== session.accountEmail && (
          <div className="mb-0.5 flex min-w-0 gap-2">
            <span className="w-8 shrink-0 text-[var(--muted-text)]">From</span>
            <span className="min-w-0 break-words text-[var(--foreground)]">
              {session.fromEmail}
            </span>
          </div>
        )}
        <RecipientField
          label="To"
          recipients={session.to}
          onChange={setTo}
          placeholder="Recipients"
          moveTargets={[
            { label: 'Cc', target: 'cc' },
            { label: 'Bcc', target: 'bcc' },
          ]}
          onMove={(r, target) => handleMoveRecipient(r, 'to', target)}
          trailing={
            !alwaysShowCcBcc && (!showCc || !showBcc) ? (
              <div className="flex shrink-0 items-center gap-2 pt-1.5 text-xs">
                {!showCc && (
                  <Button
                    type="button"
                    onPress={() => setCcExpanded(true)}
                    className="kylins-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Show Cc field"
                  >
                    Cc
                  </Button>
                )}
                {!showBcc && (
                  <Button
                    type="button"
                    onPress={() => setBccExpanded(true)}
                    className="kylins-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Show Bcc field"
                  >
                    Bcc
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />
        {(showCc || showBcc) && (
          <div className="mt-1 space-y-1" onBlur={handleAddressBlockBlur}>
            {showCc && (
              <RecipientField
                label="Cc"
                recipients={session.cc}
                onChange={setCc}
                placeholder="Cc recipients"
                moveTargets={[
                  { label: 'To', target: 'to' },
                  { label: 'Bcc', target: 'bcc' },
                ]}
                onMove={(r, target) => handleMoveRecipient(r, 'cc', target)}
              />
            )}
            {showBcc && (
              <RecipientField
                label="Bcc"
                recipients={session.bcc}
                onChange={setBcc}
                placeholder="Bcc recipients"
                moveTargets={[
                  { label: 'To', target: 'to' },
                  { label: 'Cc', target: 'cc' },
                ]}
                onMove={(r, target) => handleMoveRecipient(r, 'bcc', target)}
              />
            )}
          </div>
        )}
        <div className="mt-1 flex items-center gap-2">
          <span className="w-14 shrink-0 text-[var(--muted-text)]">Subject</span>
          <TextField className="min-w-0 flex-1" aria-label="Subject">
            <Input
              type="text"
              value={session.subject}
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

      {/* Attachments — mirrors the modal Composer layout (below editor). */}
      <div className="border-t border-[var(--border)]">
        {isForward && (
          <div className="flex items-center gap-2 px-4 py-1.5">
            <Checkbox
              isSelected={session.includeOriginalAttachments}
              onChange={(selected) => setIncludeOriginalAttachments(selected)}
              className="flex items-center gap-2 text-[var(--foreground)]"
            >
              <span className="text-xs">Include original attachments</span>
            </Checkbox>
          </div>
        )}
        {session.attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-1.5">
            {session.attachments.map((att) => (
              <span
                key={att.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
              >
                <span className="max-w-[150px] truncate">{att.filename}</span>
                <Button
                  type="button"
                  onPress={() => removeAttachment(att.id)}
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
