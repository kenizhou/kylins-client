// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.
//
// Notable adaptations vs velo:
// - StarterKit v3 (bundles Link + Underline); Placeholder + Image extensions.
// - Send/draft path goes through Kylins' composer services (send.ts, drafts.ts,
//   draftAutoSave.ts), not velo's monolithic emailActions.
// - No CSSTransition (plain null-when-closed render; the editor remounts fresh
//   each open, which also fixes velo's stale-content-on-reopen issue).
// - Kylins CSS-var tokens + hugeicons; no ui/Button / lucide deps.
// - Send-and-archive is deferred (needs the viewer's archiveThread); Send-As
//   alias reply-resolution is simplified to the default identity (TODO: port
//   resolveFromAddress when the viewer lands).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';

import { RecipientField } from '@/features/composer/RecipientField';
import type { MoveTarget } from '@/features/composer/RecipientField';
import { buildComposerExtensions } from '@/features/composer/editorExtensions';
import { EditorToolbar } from './EditorToolbar';
import { AttachmentPicker } from './AttachmentPicker';
import { ScheduleSendDialog } from './ScheduleSendDialog';
import { SignatureSelector } from './SignatureSelector';
import { TemplatePicker } from './TemplatePicker';
import { FromSelector } from './FromSelector';
import { ClassificationSelector } from '@/features/composer/ClassificationSelector';
import { useComposerStore } from '@/stores/composerStore';
import { useAccountStore } from '@/stores/accountStore';
import { usePreferencesStore } from '@/stores/preferencesStore';
import { useClassification } from '@/features/classification/useClassification';
import { sendEmail } from '@/services/composer/send';
import { deleteDraft } from '@/services/composer/drafts';
import { startAutoSave, stopAutoSave } from '@/services/composer/draftAutoSave';
import { invoke } from '@tauri-apps/api/core';
import { upsertContact } from '@/services/db/contacts';
import { insertScheduledEmail } from '@/services/db/scheduledEmails';
import { getDefaultSignature, signatureContextForComposerMode } from '@/services/db/signatures';
import {
  getAliasesForAccount,
  mapDbAlias,
  accountAsAlias,
  type SendAsAlias,
} from '@/services/db/sendAsAliases';
import { getTemplatesForAccount, type DbTemplate } from '@/services/db/templates';
import { interpolateVariables } from '@/utils/templateVariables';
import { formatRecipients } from '@/features/composer/contacts';
import type { Recipient } from '@/features/composer/contacts';
import { applySignatureAboveQuote } from '@/features/composer/signaturePlacement';
import { readFileAsBase64 } from '@/utils/fileUtils';
import {
  MaximizeIcon,
  RestoreIcon,
  PopOutIcon,
  PlusIcon,
  WarningIcon,
  ClockIcon,
  CloseIcon,
} from '../icons';
import { IconButton } from '@/components/ui/IconButton';
import { WindowTitleBar } from '@/components/ui/WindowTitleBar';
import { InputDialog } from '@/components/ui/InputDialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CommandRibbon } from '@/components/layout/CommandRibbon';
import { ClassificationWatermark } from '@/features/classification/components/ClassificationWatermark';
import { isProminent } from '@/features/classification/classificationStyle';
import { WindowErrorBoundary } from '@/components/ui/WindowErrorBoundary';

const noDragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'no-drag',
};

interface ComposerProps {
  windowed?: boolean;
}

export function Composer({ windowed = false }: ComposerProps) {
  // Individual selectors — only re-render when each value changes.
  const isOpen = useComposerStore((s) => s.isOpen);
  const mode = useComposerStore((s) => s.mode);
  const to = useComposerStore((s) => s.to);
  const cc = useComposerStore((s) => s.cc);
  const bcc = useComposerStore((s) => s.bcc);
  const subject = useComposerStore((s) => s.subject);
  const showCcBcc = useComposerStore((s) => s.showCcBcc);
  const fromEmail = useComposerStore((s) => s.fromEmail);
  const viewMode = useComposerStore((s) => s.viewMode);
  const signatureHtml = useComposerStore((s) => s.signatureHtml);
  const signatureId = useComposerStore((s) => s.signatureId);
  const classificationId = useComposerStore((s) => s.classificationId);
  const isSaving = useComposerStore((s) => s.isSaving);
  const lastSavedAt = useComposerStore((s) => s.lastSavedAt);
  // bodyHtml is intentionally NOT subscribed — TipTap owns editor state.
  const closeComposer = useComposerStore((s) => s.closeComposer);
  const setTo = useComposerStore((s) => s.setTo);
  const setCc = useComposerStore((s) => s.setCc);
  const setBcc = useComposerStore((s) => s.setBcc);
  const setSubject = useComposerStore((s) => s.setSubject);
  const setShowCcBcc = useComposerStore((s) => s.setShowCcBcc);
  const setFromEmail = useComposerStore((s) => s.setFromEmail);
  const setViewMode = useComposerStore((s) => s.setViewMode);
  const addAttachment = useComposerStore((s) => s.addAttachment);

  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccount = accounts.find((a) => a.id === activeAccountId);

  const { getLevelById, getDefaultLevel } = useClassification();
  const currentLevel = getLevelById(classificationId) ?? getDefaultLevel();

  const enableRichText = usePreferencesStore((s) => s.enableRichText);
  const checkSpelling = usePreferencesStore((s) => s.checkSpelling);
  const undoSendDuration = usePreferencesStore((s) => s.undoSendDuration);
  const messageSentSound = usePreferencesStore((s) => s.messageSentSound);

  const sendingRef = useRef(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [aliases, setAliases] = useState<SendAsAlias[]>([]);
  const templateShortcutsRef = useRef<DbTemplate[]>([]);
  const dragCounterRef = useRef(0);

  const editor = useEditor({
    extensions: buildComposerExtensions('Write your message...'),
    content: useComposerStore.getState().bodyHtml,
    onUpdate: ({ editor: ed }) => {
      useComposerStore.getState().setBodyHtml(ed.getHTML());

      // Template shortcut expansion (e.g. ";sig" → signature template body).
      const templates = templateShortcutsRef.current;
      if (templates.length === 0) return;

      const text = ed.state.doc.textContent;
      for (const tmpl of templates) {
        if (!tmpl.shortcut) continue;
        if (text.endsWith(tmpl.shortcut)) {
          const { from } = ed.state.selection;
          const deleteFrom = from - tmpl.shortcut.length;
          if (deleteFrom >= 0) {
            const state = useComposerStore.getState();
            const account = useAccountStore
              .getState()
              .accounts.find((a) => a.id === useAccountStore.getState().activeAccountId);
            interpolateVariables(tmpl.body_html, {
              recipientEmail: state.to[0]?.email,
              senderEmail: account?.email,
              senderName: account?.displayName ?? undefined,
              subject: state.subject || undefined,
            }).then((resolved) => {
              ed.chain().deleteRange({ from: deleteFrom, to: from }).insertContent(resolved).run();
            });
            if (tmpl.subject && !state.subject) {
              setSubject(tmpl.subject);
            }
          }
          break;
        }
      }
    },
    editorProps: {
      attributes: {
        class:
          'kylins-editor max-w-none px-4 py-3 min-h-[200px] focus:outline-none text-[var(--foreground)]',
        spellcheck: String(checkSpelling),
      },
      handleKeyDown: (_view, event) => {
        // Cmd/Ctrl+K → open the link dialog (also reachable via the toolbar button).
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          setShowLinkDialog(true);
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        // Let file drops bubble to the composer's onDrop for attachment handling
        // instead of becoming inline image content.
        if (event.dataTransfer?.files?.length) return true;
        return false;
      },
    },
  });

  // Place the account signature above the quoted original (or at the end for a
  // new compose). useEditor reads `content` only at mount, so when the signature
  // loads — or the user picks a different one — we push it into the editor via
  // setContent. Guarded by lastSigIdRef so it runs once per signature and never
  // clobbers the user's typing on unrelated renders.
  const lastSigIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!editor) return;
    const sigId = signatureId ?? 'none';
    if (lastSigIdRef.current === sigId) return;
    const prev = lastSigIdRef.current;
    lastSigIdRef.current = sigId;
    // Skip the very first run before a signature has loaded — the editor was
    // already seeded with bodyHtml at mount (which carries a signature already
    // when popped out of the inline composer).
    if (prev === undefined && signatureId === null) return;
    const sig = signatureHtml ? { id: signatureId ?? 'sig', html: signatureHtml } : null;
    editor.commands.setContent(applySignatureAboveQuote(editor.getHTML(), sig), {
      emitUpdate: false,
    });
  }, [editor, signatureId, signatureHtml]);

  // Load signature, aliases, and templates when the composer opens.
  useEffect(() => {
    if (!isOpen || !activeAccountId || !activeAccount) return;
    let cancelled = false;

    Promise.all([
      getDefaultSignature(activeAccountId, signatureContextForComposerMode(mode)),
      getAliasesForAccount(activeAccountId),
      getTemplatesForAccount(activeAccountId),
    ]).then(([sig, dbAliases, templates]) => {
      if (cancelled) return;
      const store = useComposerStore.getState();

      // Respect a signature already chosen by the caller (e.g. pop-out restore).
      if (!store.signatureId && sig) {
        store.setSignatureHtml(sig.body_html);
        store.setSignatureId(sig.id);
      }

      // Account address first, then DB aliases, de-duplicated by email.
      const seen = new Set<string>();
      const merged = [accountAsAlias(activeAccount), ...dbAliases.map(mapDbAlias)].filter((a) => {
        if (seen.has(a.email)) return false;
        seen.add(a.email);
        return true;
      });
      setAliases(merged);
      if (!store.fromEmail) {
        store.setFromEmail(merged[0]?.email ?? activeAccount.email);
      }

      templateShortcutsRef.current = templates.filter((t) => t.shortcut);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, activeAccountId, activeAccount]);

  // Start/stop draft auto-save.
  useEffect(() => {
    if (!isOpen || !activeAccountId) return;
    startAutoSave(activeAccountId);
    return () => stopAutoSave();
  }, [isOpen, activeAccountId]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      for (const file of Array.from(files)) {
        const content = await readFileAsBase64(file);
        addAttachment({
          id: crypto.randomUUID(),
          file,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          content,
        });
      }
    },
    [addAttachment],
  );

  // The signature now lives in the editor body (above the quoted original), so
  // the full HTML is just the editor's content. The <signature> wrapper is
  // unwrapped at the send boundary (services/composer/send strips it).
  const getFullHtml = useCallback(() => editor?.getHTML() ?? '', [editor]);

  const handleSend = useCallback(async () => {
    if (!activeAccountId || !activeAccount || sendingRef.current) return;
    const state = useComposerStore.getState();
    if (state.to.length === 0) return;
    if (!state.classificationId) return;

    sendingRef.current = true;
    stopAutoSave();

    const html = getFullHtml();
    const currentDraftId = state.draftId;

    const input = {
      accountId: activeAccountId,
      to: state.to,
      cc: state.cc.length > 0 ? state.cc : undefined,
      bcc: state.bcc.length > 0 ? state.bcc : undefined,
      subject: state.subject,
      bodyHtml: html,
      fromEmail: state.fromEmail ?? activeAccount.email,
      threadId: state.threadId,
      inReplyToMessageId: state.inReplyToMessageId,
      signatureId: state.signatureId,
      attachments:
        state.attachments.length > 0
          ? state.attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              content: a.content,
              size: a.size,
            }))
          : undefined,
      classificationId: state.classificationId,
      isEncrypted: state.isEncrypted,
      isSigned: state.isSigned,
      importance: state.importance,
      requestReadReceipt: state.requestReadReceipt,
      deliverAt: state.deliverAt,
      preventCopy: state.preventCopy,
    };

    const delay = parseInt(undoSendDuration ?? '5', 10) * 1000;

    state.setUndoSendVisible(true);

    const timer = setTimeout(async () => {
      try {
        await sendEmail(activeAccountId, input, currentDraftId);
        if (messageSentSound) {
          // TODO: play actual sent sound once a sound asset is bundled.
          console.log('[composer] message sent sound');
        }
        // TODO: send-and-archive (needs viewer archiveThread) — when enabled,
        // archive the thread here if the setting is on and state.threadId is set.
        await Promise.all(
          [...state.to, ...state.cc, ...state.bcc].map((r) =>
            upsertContact(r.email, r.email !== r.name ? r.name : null),
          ),
        );
      } catch (err) {
        console.error('Failed to send email:', err);
      } finally {
        useComposerStore.getState().setUndoSendVisible(false);
        sendingRef.current = false;
      }
    }, delay);

    state.setUndoSendTimer(timer);
    closeComposer();
  }, [activeAccountId, activeAccount, closeComposer, getFullHtml]);

  const handleSchedule = useCallback(
    async (scheduledAt: number) => {
      if (!activeAccountId) return;
      const state = useComposerStore.getState();
      if (state.to.length === 0) return;

      const html = getFullHtml();
      const attachmentData =
        state.attachments.length > 0
          ? JSON.stringify(
              state.attachments.map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                content: a.content,
              })),
            )
          : null;

      await insertScheduledEmail({
        accountId: activeAccountId,
        toAddresses: formatRecipients(state.to).join(', '),
        ccAddresses: state.cc.length > 0 ? formatRecipients(state.cc).join(', ') : null,
        bccAddresses: state.bcc.length > 0 ? formatRecipients(state.bcc).join(', ') : null,
        subject: state.subject,
        bodyHtml: html,
        replyToMessageId: state.inReplyToMessageId,
        threadId: state.threadId,
        scheduledAt,
        signatureId: state.signatureId,
      });

      // insertScheduledEmail has no attachment column setter, so persist the
      // serialized attachments on the most recent scheduled row for this account.
      if (attachmentData) {
        const latest = await invoke<{ id: string } | null>(
          'db_get_latest_scheduled_email_for_account',
          { accountId: activeAccountId },
        );
        if (latest) {
          await invoke<void>('db_set_scheduled_email_attachment_paths', {
            id: latest.id,
            attachmentPaths: attachmentData,
          });
        }
      }

      stopAutoSave();
      if (state.draftId) {
        try {
          await deleteDraft(state.draftId);
        } catch {
          /* ignore */
        }
      }

      setShowSchedule(false);
      closeComposer();
    },
    [activeAccountId, closeComposer, getFullHtml, setShowSchedule],
  );

  const closeWindowIfWindowed = useCallback(async () => {
    if (!windowed) return;
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore in non-Tauri contexts */
    }
  }, [windowed]);

  const handleDiscard = useCallback(async () => {
    stopAutoSave();
    const currentDraftId = useComposerStore.getState().draftId;
    if (currentDraftId) {
      try {
        await deleteDraft(currentDraftId);
      } catch {
        /* ignore */
      }
    }
    closeComposer();
    await closeWindowIfWindowed();
  }, [closeComposer, closeWindowIfWindowed]);

  const handleClose = useCallback(async () => {
    stopAutoSave();
    closeComposer();
    await closeWindowIfWindowed();
  }, [closeComposer, closeWindowIfWindowed]);

  const handleSendAndCloseWindow = useCallback(async () => {
    await handleSend();
    await closeWindowIfWindowed();
  }, [handleSend, closeWindowIfWindowed]);

  // Listen for menubar/ribbon action requests so the same handlers work whether
  // the user clicks the panel footer, the compose ribbon, or the menu bar.
  useEffect(() => {
    function handleSendRequested() {
      if (windowed) {
        void handleSendAndCloseWindow();
      } else {
        void handleSend();
      }
    }
    function handleScheduleRequested() {
      setShowSchedule(true);
    }
    function handleInsertLink() {
      setShowLinkDialog(true);
    }

    window.addEventListener('composer:send-requested', handleSendRequested);
    window.addEventListener('composer:schedule-requested', handleScheduleRequested);
    window.addEventListener('composer:insert-link', handleInsertLink);

    return () => {
      window.removeEventListener('composer:send-requested', handleSendRequested);
      window.removeEventListener('composer:schedule-requested', handleScheduleRequested);
      window.removeEventListener('composer:insert-link', handleInsertLink);
    };
  }, [handleSend, handleSendAndCloseWindow, windowed]);

  const handleMoveRecipient = useCallback(
    (recipient: Recipient, from: 'to' | 'cc' | 'bcc', toField: MoveTarget) => {
      const eqEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      const lists = { to, cc, bcc };
      const setters = { to: setTo, cc: setCc, bcc: setBcc };
      setters[from](lists[from].filter((r) => !eqEmail(r.email, recipient.email)));
      if (!lists[toField].some((r) => eqEmail(r.email, recipient.email))) {
        setters[toField]([...lists[toField], recipient]);
      }
    },
    [to, cc, bcc, setTo, setCc, setBcc],
  );

  const handlePopOutComposer = useCallback(async () => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const state = useComposerStore.getState();
      const params = new URLSearchParams();
      params.set('compose', 'true');
      params.set('mode', state.mode);
      if (state.to.length > 0) params.set('to', formatRecipients(state.to).join(','));
      if (state.cc.length > 0) params.set('cc', formatRecipients(state.cc).join(','));
      if (state.bcc.length > 0) params.set('bcc', formatRecipients(state.bcc).join(','));
      if (state.subject) params.set('subject', state.subject);
      if (state.threadId) params.set('threadId', state.threadId);
      if (state.inReplyToMessageId) params.set('inReplyToMessageId', state.inReplyToMessageId);
      if (state.draftId) params.set('draftId', state.draftId);
      if (state.fromEmail) params.set('fromEmail', state.fromEmail);
      if (state.signatureId) params.set('signatureId', state.signatureId);
      if (state.classificationId) params.set('classificationId', state.classificationId);
      params.set('isEncrypted', state.isEncrypted ? '1' : '0');
      params.set('isSigned', state.isSigned ? '1' : '0');
      params.set('importance', state.importance);
      params.set('requestReadReceipt', state.requestReadReceipt ? '1' : '0');
      if (state.deliverAt != null) params.set('deliverAt', state.deliverAt.toString());
      params.set('preventCopy', state.preventCopy ? '1' : '0');
      const bodyHtml = editor?.getHTML() ?? '';
      if (bodyHtml) params.set('body', btoa(unescape(encodeURIComponent(bodyHtml))));

      const windowLabel = `compose-${Date.now()}`;
      const webview = new WebviewWindow(windowLabel, {
        url: `index.html?${params.toString()}`,
        title: state.subject || 'New Message',
        width: 700,
        height: 650,
        minWidth: 600,
        minHeight: 480,
        center: true,
        decorations: false,
        resizable: true,
        maximizable: true,
        minimizable: true,
        closable: true,
      });

      webview.once('tauri://created', () => {
        console.log('[Composer] popped out', windowLabel);
      });
      webview.once('tauri://error', (e) => {
        console.error('[Composer] pop-out failed', e);
      });

      stopAutoSave();
      closeComposer();
    } catch (err) {
      console.error('Failed to pop out composer:', err);
    }
  }, [editor, closeComposer]);

  if (!isOpen) return null;

  const isFullpage = windowed || viewMode === 'fullpage';
  const modeLabel =
    mode === 'reply'
      ? 'Reply'
      : mode === 'replyAll'
        ? 'Reply All'
        : mode === 'forward'
          ? 'Forward'
          : 'New Message';
  const savedLabel = isSaving ? 'Saving...' : lastSavedAt ? 'Draft saved' : null;

  const requiresClassification = !classificationId;
  const prominent = isProminent(currentLevel);

  const composerPanel = (
    <div
      className={`composer-panel pointer-events-auto relative flex flex-col rounded-xl border bg-[var(--background)] shadow-2xl ${
        windowed
          ? 'h-full w-full rounded-none border-0 shadow-none'
          : isFullpage
            ? 'h-full max-w-5xl w-full'
            : 'h-[min(760px,85vh)] w-[min(900px,92vw)]'
      } ${isDragging ? 'border-2 border-[var(--primary)]' : 'border-[var(--border)]'}`}
      style={{
        borderTopWidth: '3px',
        borderTopColor: currentLevel.color,
        backgroundColor: prominent ? `${currentLevel.color}10` : undefined,
      }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-[var(--primary)] bg-[var(--accent)]/90">
          <div className="rounded-full bg-[var(--primary)] p-3 text-[var(--primary-fg)]">
            <PlusIcon size={24} />
          </div>
          <span className="text-sm font-medium text-[var(--accent-foreground)]">
            Drop files to attach
          </span>
        </div>
      )}

      {/* Header */}
      {windowed ? (
        <WindowTitleBar title={modeLabel} />
      ) : (
        <div className="flex items-center justify-between rounded-t-lg border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
          <span className="text-sm font-medium text-[var(--foreground)]">{modeLabel}</span>
          <div className="flex items-center gap-0.5">
            <IconButton
              size="sm"
              icon={isFullpage ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
              title={isFullpage ? 'Collapse' : 'Expand'}
              onClick={() => setViewMode(isFullpage ? 'modal' : 'fullpage')}
            />
            <IconButton
              size="sm"
              icon={<PopOutIcon size={14} />}
              title="Open in new window"
              onClick={handlePopOutComposer}
            />
            <IconButton
              size="sm"
              icon={<CloseIcon size={14} />}
              title="Close composer"
              onClick={handleClose}
            />
          </div>
        </div>
      )}

      <div className="shrink-0" style={noDragStyle}>
        <CommandRibbon mode="compose" />
      </div>

      {requiresClassification && (
        <div className="shrink-0 bg-[var(--amber)] px-3 py-1.5 text-[11px] font-semibold text-[var(--amber-foreground,#111827)]">
          <span className="inline-flex items-center gap-1.5">
            <WarningIcon size={14} />
            <span>Select a classification before sending.</span>
          </span>
        </div>
      )}

      {/* Address fields */}
      <div className="space-y-1.5 border-b border-[var(--border)] px-3 py-2">
        <FromSelector
          aliases={aliases}
          selectedEmail={fromEmail ?? activeAccount?.email ?? ''}
          onChange={(alias) => setFromEmail(alias.email)}
        />
        <RecipientField
          label="To"
          recipients={to}
          onChange={setTo}
          placeholder="Recipients"
          moveTargets={[
            { label: 'Cc', target: 'cc' },
            { label: 'Bcc', target: 'bcc' },
          ]}
          onMove={(r, target) => handleMoveRecipient(r, 'to', target)}
        />
        {showCcBcc ? (
          <>
            <RecipientField
              label="Cc"
              recipients={cc}
              onChange={setCc}
              placeholder="Cc recipients"
              moveTargets={[
                { label: 'To', target: 'to' },
                { label: 'Bcc', target: 'bcc' },
              ]}
              onMove={(r, target) => handleMoveRecipient(r, 'cc', target)}
            />
            <RecipientField
              label="Bcc"
              recipients={bcc}
              onChange={setBcc}
              placeholder="Bcc recipients"
              moveTargets={[
                { label: 'To', target: 'to' },
                { label: 'Cc', target: 'cc' },
              ]}
              onMove={(r, target) => handleMoveRecipient(r, 'bcc', target)}
            />
          </>
        ) : (
          <button onClick={() => setShowCcBcc(true)} className="kylins-link ml-10 text-xs">
            Cc / Bcc
          </button>
        )}
      </div>

      {/* Subject */}
      <div className="border-b border-[var(--border)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <ClassificationSelector />
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 bg-transparent text-[15px] font-medium text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
          />
        </div>
      </div>

      {/* Editor toolbar */}
      {enableRichText && (
        <EditorToolbar editor={editor} onRequestLink={() => setShowLinkDialog(true)} />
      )}

      {/* Editor */}
      <div className="relative flex-1 overflow-y-auto">
        {prominent && (
          <ClassificationWatermark
            level={currentLevel}
            identity={fromEmail ?? activeAccount?.email}
          />
        )}
        <EditorContent editor={editor} />
      </div>

      {/* Attachments */}
      <div className="border-t border-[var(--border)]">
        <AttachmentPicker />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between rounded-b-lg border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="text-xs text-[var(--muted-foreground)]">
            {fromEmail ?? activeAccount?.email ?? 'No account'}
          </div>
          {savedLabel && (
            <span
              className={`text-xs italic text-[var(--muted-foreground)] transition-opacity duration-200 ${
                isSaving ? 'animate-pulse' : ''
              }`}
            >
              {savedLabel}
            </span>
          )}
          <SignatureSelector />
          <TemplatePicker editor={editor} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDiscard}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
          >
            Discard
          </button>
          <div className="flex items-center">
            <button
              onClick={windowed ? handleSendAndCloseWindow : handleSend}
              disabled={to.length === 0 || requiresClassification}
              title={requiresClassification ? 'Select a classification before sending' : undefined}
              className="rounded-l-md bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send
            </button>
            <button
              onClick={() => setShowSchedule(true)}
              disabled={to.length === 0 || requiresClassification}
              className="rounded-r-md border-l border-white/20 bg-[var(--primary)] py-1.5 px-2 text-[var(--primary-fg)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              title="Schedule send"
            >
              <ClockIcon size={12} />
            </button>
          </div>
        </div>
      </div>

      {showSchedule && (
        <ScheduleSendDialog onSchedule={handleSchedule} onClose={() => setShowSchedule(false)} />
      )}

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

  if (windowed) {
    return (
      <WindowErrorBoundary>
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--background)]">
          {composerPanel}
        </div>
      </WindowErrorBoundary>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
      <div className="pointer-events-auto absolute inset-0 bg-black/30" onClick={closeComposer} />
      {composerPanel}
    </div>
  );
}
