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
import { flushSync } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import { Button, Input, TextField, Checkbox } from 'react-aria-components';

import { RecipientField } from '@/features/composer/RecipientField';
import type { MoveTarget } from '@/features/composer/RecipientField';
import { buildComposerExtensions } from '@/features/composer/editorExtensions';
import { EditorToolbar } from './EditorToolbar';
import { AttachmentPicker } from './AttachmentPicker';
import { ScheduleSendDialog } from './ScheduleSendDialog';
import { SignatureSelector } from './SignatureSelector';
import { TemplatePicker } from './TemplatePicker';
import { FromSelector } from './FromSelector';
import { ComposerTitleBar } from './window/ComposerTitleBar';
import { ComposerActionsRow } from './window/ComposerActionsRow';
import { ComposerStatusBar } from './window/ComposerStatusBar';
import { CloseConfirmDialog } from './window/CloseConfirmDialog';
import { ClassificationSelector } from '@/features/composer/ClassificationSelector';
import { useComposerStore } from '@/stores/composerStore';
import { useAccountStore } from '@/stores/accountStore';
import { useUIStore } from '@/stores/uiStore';
import { useToastStore } from '@/stores/toastStore';
import { usePreferencesStore } from '@/stores/preferencesStore';
import { useClassification } from '@/features/classification/useClassification';
import { sendEmail } from '@/services/composer/send';
import { deleteDraft } from '@/services/composer/drafts';
import { startAutoSave, stopAutoSave, flushDraftSave } from '@/services/composer/draftAutoSave';
import {
  cleanupAttachments,
  stageAttachment,
  stageAttachmentBytes,
} from '@/services/composer/attachments';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
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
import { getAttachments, fetchAttachment } from '@/services/db/attachments';
import {
  MaximizeIcon,
  RestoreIcon,
  PopOutIcon,
  PlusIcon,
  CloseIcon,
  SendIcon,
  SpinnerIcon,
} from '../icons';
import { IconButton } from '@/components/ui/IconButton';
import { InputDialog } from '@/components/ui/InputDialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CommandRibbon } from '@/components/layout/CommandRibbon';
import { ClassificationWatermark } from '@/features/classification/components/ClassificationWatermark';
import { isProminent } from '@/features/classification/classificationStyle';
import { WindowErrorBoundary } from '@/components/ui/WindowErrorBoundary';

const noDragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'no-drag',
};

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function buildMinimalEml(subject: string, body: string): string {
  return `Subject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`;
}

function newAttachmentId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

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
  const replyTo = useComposerStore((s) => s.replyTo);
  const subject = useComposerStore((s) => s.subject);
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
  const setReplyTo = useComposerStore((s) => s.setReplyTo);
  const setSubject = useComposerStore((s) => s.setSubject);
  const setFromEmail = useComposerStore((s) => s.setFromEmail);
  const setViewMode = useComposerStore((s) => s.setViewMode);
  const setIncludeOriginalAttachments = useComposerStore((s) => s.setIncludeOriginalAttachments);
  const addAttachment = useComposerStore((s) => s.addAttachment);
  const originalMessageId = useComposerStore((s) => s.originalMessageId);
  const includeOriginalAttachments = useComposerStore((s) => s.includeOriginalAttachments);
  const forwardAsAttachment = useComposerStore((s) => s.forwardAsAttachment);
  const originalMessageSubject = useComposerStore((s) => s.originalMessageSubject);
  const originalMessageHtml = useComposerStore((s) => s.originalMessageHtml);
  const originalMessageText = useComposerStore((s) => s.originalMessageText);

  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccount = accounts.find((a) => a.id === activeAccountId);

  const { getLevelById, getDefaultLevel } = useClassification();
  const currentLevel = getLevelById(classificationId) ?? getDefaultLevel();

  const enableRichText = usePreferencesStore((s) => s.enableRichText);
  const checkSpelling = usePreferencesStore((s) => s.checkSpelling);
  const undoSendDuration = usePreferencesStore((s) => s.undoSendDuration);
  const messageSentSound = usePreferencesStore((s) => s.messageSentSound);
  const alwaysShowCcBcc = usePreferencesStore((s) => s.alwaysShowCcBcc);

  const sendingRef = useRef(false);
  const sendProgressActive = useUIStore((s) => s.sendProgress.active);
  const attachmentSeededRef = useRef(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [wordStats, setWordStats] = useState({ words: 0, chars: 0 });
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [extraHeadersExpanded, setExtraHeadersExpanded] = useState(
    () => alwaysShowCcBcc || cc.length > 0 || bcc.length > 0 || replyTo.length > 0,
  );
  const showExtraHeaders = extraHeadersExpanded || alwaysShowCcBcc;
  const showCc = showExtraHeaders || cc.length > 0;
  const showBcc = showExtraHeaders || bcc.length > 0;
  const showReplyTo = showExtraHeaders || replyTo.length > 0;
  const [isDragging, setIsDragging] = useState(false);
  const [aliases, setAliases] = useState<SendAsAlias[]>([]);
  const templateShortcutsRef = useRef<DbTemplate[]>([]);
  const dragCounterRef = useRef(0);

  // Seed reply/forward attachments from the original message when requested.
  useEffect(() => {
    if (!isOpen) {
      attachmentSeededRef.current = false;
      return;
    }
    if (!originalMessageId || (!includeOriginalAttachments && !forwardAsAttachment)) return;
    if (attachmentSeededRef.current) return;

    const messageId = originalMessageId;
    let cancelled = false;
    async function seed() {
      attachmentSeededRef.current = true;

      // T7b: every staged attachment lands under the per-session outbox
      // directory (`stagingDraftId`), and only the resulting `filePath` is
      // kept on the ComposerAttachment. No base64 lingers in composer state.
      const stagingDraftId = useComposerStore.getState().stagingDraftId;

      if (includeOriginalAttachments && activeAccountId) {
        try {
          const rows = await getAttachments(activeAccountId, messageId);
          for (const row of rows) {
            if (cancelled) return;
            const partId = row.imapPartId || row.id;
            // sync_fetch_attachment returns a cached file path (no base64
            // over IPC). Copy the cached file into the draft outbox so the
            // backend MIME builder streams it at send time.
            const fetched = await fetchAttachment(activeAccountId, messageId, partId);
            if (cancelled) return;
            const destPath = await stageAttachment(
              stagingDraftId,
              fetched.filePath,
              row.filename || 'attachment',
            );
            addAttachment({
              id: newAttachmentId(),
              filename: row.filename || 'attachment',
              mimeType: fetched.mimeType || row.mimeType || 'application/octet-stream',
              size: row.size,
              filePath: destPath,
            });
          }
        } catch (err) {
          console.error('[Composer] failed to seed original attachments', err);
        }
      }

      if (forwardAsAttachment && !cancelled) {
        try {
          const body = originalMessageText ?? htmlToPlainText(originalMessageHtml ?? '');
          const eml = buildMinimalEml(originalMessageSubject ?? 'Forwarded message', body);
          const filename = `${(originalMessageSubject ?? 'message').replace(/[^a-z0-9]/gi, '_')}.eml`;
          const bytes = new TextEncoder().encode(eml);
          const staged = await stageAttachmentBytes(
            stagingDraftId,
            filename,
            'message/rfc822',
            bytes,
          );
          addAttachment({
            id: newAttachmentId(),
            filename: staged.filename,
            mimeType: staged.mimeType,
            size: bytes.length,
            filePath: staged.filePath,
          });
        } catch (err) {
          console.error('[Composer] failed to build forward-as-attachment', err);
        }
      }
    }
    seed();
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    includeOriginalAttachments,
    forwardAsAttachment,
    originalMessageId,
    activeAccountId,
    addAttachment,
    originalMessageSubject,
    originalMessageHtml,
    originalMessageText,
  ]);

  const editor = useEditor({
    extensions: buildComposerExtensions('Write your message...'),
    content: useComposerStore.getState().bodyHtml,
    onUpdate: ({ editor: ed }) => {
      useComposerStore.getState().setBodyHtml(ed.getHTML());

      // Live word/character stats for the pop-out status bar.
      const text = ed.state.doc.textContent;
      setWordStats({
        words: text.split(/\s+/).filter(Boolean).length,
        chars: text.length,
      });

      // Template shortcut expansion (e.g. ";sig" → signature template body).
      const templates = templateShortcutsRef.current;
      if (templates.length === 0) return;

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
    onCreate: ({ editor: ed }) => {
      // Seed word stats from the initial editor content (e.g. reopened draft).
      const text = ed.state.doc.textContent;
      setWordStats({
        words: text.split(/\s+/).filter(Boolean).length,
        chars: text.length,
      });
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
  }, [isOpen, activeAccountId, activeAccount, mode]);

  const modeLabel =
    mode === 'reply'
      ? 'Reply'
      : mode === 'replyAll'
        ? 'Reply All'
        : mode === 'forward'
          ? 'Forward'
          : 'New Message';

  // Start/stop draft auto-save.
  useEffect(() => {
    if (!isOpen || !activeAccountId) return;
    startAutoSave(activeAccountId);
    return () => stopAutoSave();
  }, [isOpen, activeAccountId]);

  // Start/stop draft auto-save.
  useEffect(() => {
    if (!isOpen || !activeAccountId) return;
    startAutoSave(activeAccountId);
    return () => stopAutoSave();
  }, [isOpen, activeAccountId]);

  // Keep the OS window title (taskbar / alt-tab) in sync with the subject.
  useEffect(() => {
    if (!windowed) return;
    try {
      void getCurrentWindow().setTitle(subject.trim() || modeLabel);
    } catch {
      // Ignore in non-Tauri contexts.
    }
  }, [windowed, subject, modeLabel, mode]);

  // Intercept the window close with unsaved content → confirm dialog.
  useEffect(() => {
    if (!windowed) return;
    const win = getCurrentWindow();
    if (typeof win.onCloseRequested !== 'function') return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void win
      .onCloseRequested((event) => {
        const state = useComposerStore.getState();
        const bodyEmpty = (editor?.getText().trim() ?? '') === '';
        const untouched = state.to.length === 0 && state.subject.trim() === '' && bodyEmpty;
        if (untouched) return; // empty compose closes without prompting
        event.preventDefault();
        flushSync(() => setCloseConfirmOpen(true));
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [windowed, editor]);

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
      const stagingDraftId = useComposerStore.getState().stagingDraftId;
      for (const file of Array.from(files)) {
        // T7b: stage the file to disk under the per-session outbox directory
        // and keep only the resulting `filePath` on the ComposerAttachment.
        // We read the drop payload as an ArrayBuffer (NOT base64) so a 200 MB
        // attachment never becomes a ~267 MB base64 string in JS memory; the
        // bytes go straight to disk and the Uint8Array is released.
        // The Tauri webview disables `dragDropEnabled` in tauri.conf.json, so
        // dropped File objects do not expose a `path` property here — we must
        // read bytes via the File API and write them through `stageAttachmentBytes`.
        const buf = await file.arrayBuffer();
        const staged = await stageAttachmentBytes(
          stagingDraftId,
          file.name,
          file.type || 'application/octet-stream',
          new Uint8Array(buf),
        );
        addAttachment({
          id: newAttachmentId(),
          filename: staged.filename,
          mimeType: staged.mimeType,
          size: file.size,
          filePath: staged.filePath,
        });
      }
    },
    [addAttachment],
  );

  // The signature now lives in the editor body (above the quoted original), so
  // the full HTML is just the editor's content. The <signature> wrapper is
  // unwrapped at the send boundary (services/composer/send strips it).
  const getFullHtml = useCallback(() => editor?.getHTML() ?? '', [editor]);

  const closeWindowIfWindowed = useCallback(async () => {
    if (!windowed) return;
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore in non-Tauri contexts */
    }
  }, [windowed]);

  const handleSend = useCallback(async () => {
    console.log(
      '[send-fe] handleSend ENTER stagingDraftId=',
      useComposerStore.getState().stagingDraftId,
      'toCount=',
      useComposerStore.getState().to.length,
      'sendingRef=',
      sendingRef.current,
      'windowed=',
      windowed,
      'hasLocation=',
      typeof window !== 'undefined' ? window.location.search : 'no-window',
    );
    if (!activeAccountId || !activeAccount || sendingRef.current) {
      console.log(
        '[send-fe] handleSend early-return activeAccountId=',
        activeAccountId,
        'activeAccount=',
        !!activeAccount,
        'sendingRef=',
        sendingRef.current,
      );
      return;
    }
    const state = useComposerStore.getState();
    if (state.to.length === 0) {
      console.log('[send-fe] handleSend validation FAIL: no recipients');
      return;
    }
    // Fall back to the default classification level so a fresh compose (where
    // the user hasn't touched the ClassificationSelector) still sends. The
    // selector already displays the default visually via currentLevel; this
    // makes the send path agree with the display rather than silently bailing.
    const effectiveClassificationId = state.classificationId ?? getDefaultLevel().id;
    if (!effectiveClassificationId) {
      console.log('[send-fe] handleSend validation FAIL: no classificationId and no default');
      return;
    }
    console.log('[send-fe] handleSend validation OK');

    sendingRef.current = true;
    stopAutoSave();

    const html = getFullHtml();
    const currentDraftId = state.draftId;
    const currentStagingDraftId = state.stagingDraftId;

    const selectedAlias = aliases.find((a) => a.email === (state.fromEmail ?? activeAccount.email));

    const input = {
      accountId: activeAccountId,
      to: state.to,
      cc: state.cc.length > 0 ? state.cc : undefined,
      bcc: state.bcc.length > 0 ? state.bcc : undefined,
      replyTo: state.replyTo.length > 0 ? state.replyTo : undefined,
      subject: state.subject,
      bodyHtml: html,
      fromEmail: state.fromEmail ?? activeAccount.email,
      fromName: selectedAlias?.displayName ?? activeAccount.displayName ?? '',
      threadId: state.threadId,
      inReplyToMessageId: state.inReplyToMessageId,
      signatureId: state.signatureId,
      // T7b: regular attachments pass through `filePath` (no base64). The
      // backend MIME builder streams the bytes from disk at send time.
      attachments:
        state.attachments.length > 0
          ? state.attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              filePath: a.filePath,
              size: a.size,
            }))
          : undefined,
      classificationId: effectiveClassificationId,
      isEncrypted: state.isEncrypted,
      isSigned: state.isSigned,
      importance: state.importance,
      requestReadReceipt: state.requestReadReceipt,
      requestDeliveryReceipt: state.requestDeliveryReceipt,
      deliverAt: state.deliverAt,
      preventCopy: state.preventCopy,
    };

    // Core send: enqueue + delete the persisted draft + upsert recipients.
    // Returns true on success. Shared by the immediate (windowed) path and the
    // deferred (inline undo) path.
    const performSend = async (): Promise<boolean> => {
      console.log('[send-fe] handleSend performSend calling sendEmail accountId=', activeAccountId);
      try {
        const result = await sendEmail(activeAccountId, input, currentStagingDraftId);
        console.log(
          '[send-fe] handleSend sendEmail RESULT success=',
          result.success,
          'message=',
          result.message,
        );
        if (!result.success) {
          console.error('[send-fe] handleSend send failed:', result.message);
          useToastStore.getState().push(`Send failed: ${result.message}`, 'error');
          console.log('[send-fe] handleSend pushed error toast');
          return false;
        }
        // T7b: the persisted `local_drafts` row id is distinct from the staging
        // id; sendEmail handles outbox cleanup via the T8 backend, the composer
        // owns the drafts-row deletion.
        if (currentDraftId) {
          try {
            await deleteDraft(currentDraftId);
          } catch {
            /* ignore — best-effort */
          }
        }
        if (messageSentSound) {
          // TODO: play actual sent sound once a sound asset is bundled.
          console.log('[send-fe] handleSend message sent sound (stub)');
        }
        // TODO: send-and-archive (needs viewer archiveThread) — when enabled,
        // archive the thread here if the setting is on and state.threadId is set.
        await Promise.all(
          [...state.to, ...state.cc, ...state.bcc].map((r) =>
            upsertContact(r.email, r.email !== r.name ? r.name : null),
          ),
        );
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[send-fe] handleSend sendEmail THREW:', message);
        useToastStore.getState().push(`Send failed: ${message}`, 'error');
        console.log('[send-fe] handleSend pushed error toast (from catch)');
        return false;
      }
    };

    if (windowed) {
      // Popout: send NOW and close on success (no undo timer — matches Outlook).
      // Undo-send is a main-window/inline feature (the UndoSendToast lives in
      // AppShell, which the popout doesn't render), and deferring the send is
      // unsafe in a window that's about to close. Keep the window open on
      // failure so the user can retry.
      console.log('[send-fe] handleSend IMMEDIATE (windowed) — no undo timer');
      const ok = await performSend();
      sendingRef.current = false;
      console.log('[send-fe] handleSend immediate done ok=', ok);
      if (ok) {
        console.log('[send-fe] handleSend windowed send succeeded → closing popout');
        await closeWindowIfWindowed();
      }
      return;
    }

    // Inline (main window): defer the send by the undo window so the user can
    // cancel via the UndoSendToast (rendered in AppShell, which persists).
    const delay = parseInt(undoSendDuration ?? '5', 10) * 1000;
    state.setUndoSendVisible(true);
    state.setUndoStagingDraftId(currentStagingDraftId);
    console.log(
      '[send-fe] handleSend undoSendVisible=true delayMs=',
      delay,
      'stagingDraftId=',
      currentStagingDraftId,
    );
    const timer = setTimeout(async () => {
      console.log('[send-fe] handleSend undo-timer FIRED');
      await performSend();
      useComposerStore.getState().setUndoSendVisible(false);
      sendingRef.current = false;
      console.log('[send-fe] handleSend undo-timer done');
    }, delay);
    state.setUndoSendTimer(timer);
    console.log('[send-fe] handleSend undo-timer SCHEDULED; closing composer');
    closeComposer();
  }, [
    activeAccountId,
    activeAccount,
    aliases,
    closeComposer,
    closeWindowIfWindowed,
    getFullHtml,
    getDefaultLevel,
    messageSentSound,
    undoSendDuration,
    windowed,
  ]);

  const handleSchedule = useCallback(
    async (scheduledAt: number) => {
      if (!activeAccountId) return;
      const state = useComposerStore.getState();
      if (state.to.length === 0) return;

      const html = getFullHtml();
      // T7b: schedule metadata persists path-backed refs (no base64). The
      // staged files remain under the per-session outbox directory; a future
      // scheduled-send worker would stream them at the scheduled time.
      const attachmentData =
        state.attachments.length > 0
          ? JSON.stringify(
              state.attachments.map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                filePath: a.filePath,
                size: a.size,
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

  const handleDiscard = useCallback(async () => {
    stopAutoSave();
    const state = useComposerStore.getState();
    const currentDraftId = state.draftId;
    const currentStagingDraftId = state.stagingDraftId;
    if (currentDraftId) {
      try {
        await deleteDraft(currentDraftId);
      } catch {
        /* ignore */
      }
    }
    // T7b: best-effort cleanup of any staged attachment files. On send-success
    // the T8 backend cleans the same directory; on user discard we do it here.
    // Per-attachment removal mid-compose can leave orphans, so we clean the
    // whole outbox folder at discard.
    try {
      await cleanupAttachments(currentStagingDraftId);
    } catch {
      /* ignore — best-effort */
    }
    closeComposer();
    await closeWindowIfWindowed();
  }, [closeComposer, closeWindowIfWindowed]);

  const handleClose = useCallback(async () => {
    stopAutoSave();
    const state = useComposerStore.getState();
    const currentDraftId = state.draftId;
    const currentStagingDraftId = state.stagingDraftId;
    // Best-effort cleanup of staged attachments for unsaved drafts. Saved drafts
    // keep their filePath references, so we leave the outbox directory alone.
    if (!currentDraftId) {
      try {
        await cleanupAttachments(currentStagingDraftId);
      } catch {
        /* ignore — best-effort */
      }
    }
    closeComposer();
    await closeWindowIfWindowed();
  }, [closeComposer, closeWindowIfWindowed]);

  const handleSaveDraftAndClose = useCallback(async () => {
    try {
      await flushDraftSave();
    } catch (e) {
      useToastStore
        .getState()
        .push(`Save draft failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      return; // keep the window open so the user can retry
    }
    stopAutoSave();
    closeComposer();
    await closeWindowIfWindowed();
  }, [closeComposer, closeWindowIfWindowed]);

  // Windowed Send: delegate to handleSend. The popout window is now closed
  // INSIDE handleSend's undo-timer finally block (after sendEmail succeeds) —
  // closing here would destroy the window (and the pending timer) before the
  // deferred send fires.
  const handleSendAndCloseWindow = useCallback(async () => {
    await handleSend();
  }, [handleSend]);

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
    // Attach button: open the OS file picker, then stage each picked file via
    // the backend `stage_picked_attachment` command. The frontend fs scope
    // only covers appData, so the copy of an arbitrary picked path must go
    // through Rust (std::fs has full access). The resulting `filePath` lives
    // on the ComposerAttachment and is streamed into the MIME builder at send.
    async function handleAttachRequested() {
      try {
        const selected = await open({ multiple: true });
        if (!selected) return;
        const paths = Array.isArray(selected) ? selected : [selected];
        if (paths.length === 0) return;
        const stagingDraftId = useComposerStore.getState().stagingDraftId;
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
          });
        }
      } catch (err) {
        console.error('[Composer] attach pick failed', err);
        useToastStore
          .getState()
          .push(`Attach failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    }

    window.addEventListener('composer:send-requested', handleSendRequested);
    window.addEventListener('composer:schedule-requested', handleScheduleRequested);
    window.addEventListener('composer:insert-link', handleInsertLink);
    window.addEventListener('composer:attach-requested', handleAttachRequested);

    return () => {
      window.removeEventListener('composer:send-requested', handleSendRequested);
      window.removeEventListener('composer:schedule-requested', handleScheduleRequested);
      window.removeEventListener('composer:insert-link', handleInsertLink);
      window.removeEventListener('composer:attach-requested', handleAttachRequested);
    };
  }, [handleSend, handleSendAndCloseWindow, windowed, addAttachment]);

  const handleMoveRecipient = useCallback(
    (recipient: Recipient, from: 'to' | 'cc' | 'bcc' | 'replyTo', toField: MoveTarget) => {
      const eqEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      const lists = { to, cc, bcc, replyTo };
      const setters = { to: setTo, cc: setCc, bcc: setBcc, replyTo: setReplyTo };
      setters[from](lists[from].filter((r) => !eqEmail(r.email, recipient.email)));
      if (toField === 'replyTo') {
        if (!replyTo.some((r) => eqEmail(r.email, recipient.email))) {
          setReplyTo([...replyTo, recipient]);
        }
        return;
      }
      if (!lists[toField].some((r) => eqEmail(r.email, recipient.email))) {
        setters[toField]([...lists[toField], recipient]);
      }
    },
    [to, cc, bcc, replyTo, setTo, setCc, setBcc, setReplyTo],
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
      if (state.replyTo.length > 0)
        params.set('replyTo', formatRecipients(state.replyTo).join(','));
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
      params.set('requestDeliveryReceipt', state.requestDeliveryReceipt ? '1' : '0');
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

  const handleAddressBlockBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (alwaysShowCcBcc) return;
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (cc.length === 0 && bcc.length === 0 && replyTo.length === 0) {
      setExtraHeadersExpanded(false);
    }
  };

  if (!isOpen) return null;

  const isFullpage = windowed || viewMode === 'fullpage';
  const savedLabel = isSaving ? 'Saving...' : lastSavedAt ? 'Draft saved' : null;

  const prominent = isProminent(currentLevel);

  const composerPanel = (
    <div
      className={`composer-panel pointer-events-auto relative flex flex-col rounded-2xl border bg-[var(--background)] shadow-2xl ${
        windowed
          ? 'h-full w-full rounded-none border-0 shadow-none'
          : isFullpage
            ? 'h-full max-w-5xl w-full'
            : 'h-[min(760px,85vh)] w-[min(900px,92vw)]'
      } ${isDragging ? 'border-2 border-[var(--primary)]' : 'border-[var(--border)]'}`}
      style={{
        ...(windowed ? {} : { borderTopWidth: '3px', borderTopColor: currentLevel.color }),
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
        <>
          <ComposerTitleBar title={subject.trim() || modeLabel} />
          <ComposerActionsRow
            canSend={to.length > 0}
            sending={sendProgressActive}
            onSend={() => void handleSendAndCloseWindow()}
            onDiscard={() => void handleDiscard()}
            onSchedule={() => setShowSchedule(true)}
          />
        </>
      ) : (
        <div className="flex items-center justify-between rounded-t-2xl border-b border-[var(--border-subtle)] bg-[var(--chrome-tint)] px-4 py-2.5">
          <span className="text-sm font-medium text-[var(--foreground)]">{modeLabel}</span>
          <div className="flex items-center gap-0.5">
            <IconButton
              size="sm"
              icon={isFullpage ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
              title={isFullpage ? 'Collapse' : 'Expand'}
              aria-label={isFullpage ? 'Collapse composer' : 'Maximize composer'}
              onClick={() => setViewMode(isFullpage ? 'modal' : 'fullpage')}
            />
            <IconButton
              size="sm"
              icon={<PopOutIcon size={14} />}
              title="Open in new window"
              aria-label="Pop out composer"
              onClick={handlePopOutComposer}
            />
            <IconButton
              size="sm"
              icon={<CloseIcon size={14} />}
              title="Close composer"
              aria-label="Close composer"
              onClick={handleClose}
            />
          </div>
        </div>
      )}

      {/* Command ribbon + address fields + subject (watermark overlays this area) */}
      <div
        className="relative shrink-0"
        style={{ backgroundColor: prominent ? `${currentLevel.color}08` : undefined }}
      >
        {prominent && <ClassificationWatermark level={currentLevel} />}
        <div className="relative z-20">
          <div className="shrink-0" style={noDragStyle}>
            <CommandRibbon mode="compose" />
          </div>

          {/* Address fields */}
          <div className="space-y-1.5 border-b border-[var(--border)] px-3 py-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                {aliases.length > 1 ? (
                  <FromSelector
                    aliases={aliases}
                    selectedEmail={fromEmail ?? activeAccount?.email ?? ''}
                    onChange={(alias) => setFromEmail(alias.email)}
                  />
                ) : (
                  <div className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                    <span className="w-8 shrink-0 text-xs font-medium text-[var(--muted-text)]">
                      From
                    </span>
                    <span className="min-w-0 truncate">
                      {aliases[0]?.displayName
                        ? `${aliases[0].displayName} <${aliases[0].email}>`
                        : (aliases[0]?.email ?? activeAccount?.email ?? '')}
                    </span>
                  </div>
                )}
              </div>
              {!alwaysShowCcBcc && !showExtraHeaders && (
                <div className="flex items-center gap-2 text-xs text-[var(--muted-text)]">
                  <span className="text-[var(--border)]" aria-hidden="true">
                    |
                  </span>
                  <Button
                    onPress={() => setExtraHeadersExpanded(true)}
                    className="kylins-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Show Cc, Bcc and Reply-To fields"
                  >
                    Cc
                  </Button>
                </div>
              )}
            </div>
            <RecipientField
              label="To"
              recipients={to}
              onChange={setTo}
              placeholder="Recipients"
              moveTargets={[
                { label: 'Cc', target: 'cc' },
                { label: 'Bcc', target: 'bcc' },
                { label: 'Reply-To', target: 'replyTo' },
              ]}
              onMove={(r, target) => handleMoveRecipient(r, 'to', target)}
            />
            {(showCc || showBcc || showReplyTo || alwaysShowCcBcc) && (
              <div className="space-y-1" onBlur={handleAddressBlockBlur}>
                {showCc && (
                  <RecipientField
                    label="Cc"
                    recipients={cc}
                    onChange={setCc}
                    placeholder="Cc recipients"
                    moveTargets={[
                      { label: 'To', target: 'to' },
                      { label: 'Bcc', target: 'bcc' },
                      { label: 'Reply-To', target: 'replyTo' },
                    ]}
                    onMove={(r, target) => handleMoveRecipient(r, 'cc', target)}
                  />
                )}
                {showBcc && (
                  <RecipientField
                    label="Bcc"
                    recipients={bcc}
                    onChange={setBcc}
                    placeholder="Bcc recipients"
                    moveTargets={[
                      { label: 'To', target: 'to' },
                      { label: 'Cc', target: 'cc' },
                      { label: 'Reply-To', target: 'replyTo' },
                    ]}
                    onMove={(r, target) => handleMoveRecipient(r, 'bcc', target)}
                  />
                )}
                {showReplyTo && (
                  <RecipientField
                    label="Reply-To"
                    recipients={replyTo}
                    onChange={setReplyTo}
                    placeholder="Reply-To address"
                    moveTargets={[
                      { label: 'To', target: 'to' },
                      { label: 'Cc', target: 'cc' },
                      { label: 'Bcc', target: 'bcc' },
                    ]}
                    onMove={(r, target) => handleMoveRecipient(r, 'replyTo', target)}
                  />
                )}
              </div>
            )}
          </div>

          {/* Subject */}
          <div className="border-b border-[var(--border)] px-3 py-1.5">
            <div className="flex items-center gap-2">
              <ClassificationSelector />
              <TextField className="flex-1" aria-label="Subject">
                <Input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject"
                  className="w-full flex-1 bg-transparent text-[15px] font-medium text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
                />
              </TextField>
            </div>
          </div>
        </div>
      </div>

      {/* Editor toolbar */}
      {enableRichText && (
        <EditorToolbar editor={editor} onRequestLink={() => setShowLinkDialog(true)} />
      )}

      {/* Editor */}
      <div className="relative flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>

      {/* Attachments */}
      <div className="border-t border-[var(--border)]">
        {originalMessageId && !forwardAsAttachment && (
          <div className="flex items-center gap-2 px-4 py-1.5">
            <Checkbox
              isSelected={includeOriginalAttachments}
              onChange={setIncludeOriginalAttachments}
              className="flex items-center gap-2 text-xs text-[var(--foreground)]"
            >
              Include original attachments
            </Checkbox>
          </div>
        )}
        <AttachmentPicker />
      </div>

      {/* Footer (inline) / status bar (windowed) */}
      {windowed ? (
        <ComposerStatusBar
          editor={editor}
          wordCount={wordStats.words}
          charCount={wordStats.chars}
        />
      ) : (
        <div className="flex items-center justify-between rounded-b-2xl border-t border-[var(--border-subtle)] bg-[var(--chrome-tint)] px-4 py-2.5">
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
            <Button
              onPress={handleDiscard}
              isDisabled={sendProgressActive}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Discard
            </Button>
            <Button
              onPress={windowed ? handleSendAndCloseWindow : handleSend}
              isDisabled={to.length === 0 || sendProgressActive}
              aria-label={undefined}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-fg)] shadow-[var(--shadow-sm)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sendProgressActive ? <SpinnerIcon size={14} /> : <SendIcon size={14} />}
              {sendProgressActive ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      )}

      {windowed && (
        <CloseConfirmDialog
          isOpen={closeConfirmOpen}
          onSaveDraft={() => {
            setCloseConfirmOpen(false);
            void handleSaveDraftAndClose();
          }}
          onDiscard={() => {
            setCloseConfirmOpen(false);
            void handleDiscard();
          }}
          onCancel={() => setCloseConfirmOpen(false)}
        />
      )}

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
    <div className="fixed inset-0 z-[var(--z-modal-backdrop)] flex items-center justify-center p-4 pointer-events-none">
      <div
        className="pointer-events-auto absolute inset-0 bg-[var(--backdrop)]"
        onClick={handleClose}
      />
      {composerPanel}
    </div>
  );
}
