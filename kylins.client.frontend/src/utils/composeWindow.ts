import { type Recipient } from '@/features/composer/contacts';
import { formatRecipients } from '@/features/composer/contacts';
import type { ComposerMode, Importance } from '@/stores/composerStore';

export interface ComposeWindowOptions {
  mode?: ComposerMode;
  to?: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  replyTo?: Recipient[];
  subject?: string;
  bodyHtml?: string;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  draftId?: string | null;
  fromEmail?: string | null;
  signatureId?: string | null;
  classificationId?: string | null;
  isEncrypted?: boolean;
  isSigned?: boolean;
  importance?: Importance;
  requestReadReceipt?: boolean;
  requestDeliveryReceipt?: boolean;
  deliverAt?: number | null;
  preventCopy?: boolean;
  originalMessageId?: string | null;
  includeOriginalAttachments?: boolean;
  forwardAsAttachment?: boolean;
  originalMessageSubject?: string;
  originalMessageHtml?: string | null;
  originalMessageText?: string | null;
}

/**
 * Opens a dedicated, resizable composer window.
 * The target page reads the query params in App.tsx and renders the composer
 * in fullpage mode.
 */
export async function openComposerWindow(opts: ComposeWindowOptions = {}): Promise<void> {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!isTauri) {
    // Fallback for non-Tauri contexts: open inline via the store.
    const { useComposerStore } = await import('@/stores/composerStore');
    useComposerStore.getState().openComposer({
      mode: opts.mode,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      replyTo: opts.replyTo,
      subject: opts.subject,
      bodyHtml: opts.bodyHtml,
      threadId: opts.threadId,
      inReplyToMessageId: opts.inReplyToMessageId,
      draftId: opts.draftId,
      fromEmail: opts.fromEmail,
      signatureId: opts.signatureId,
      classificationId: opts.classificationId,
      isEncrypted: opts.isEncrypted,
      isSigned: opts.isSigned,
      importance: opts.importance,
      requestReadReceipt: opts.requestReadReceipt,
      requestDeliveryReceipt: opts.requestDeliveryReceipt,
      deliverAt: opts.deliverAt,
      preventCopy: opts.preventCopy,
      originalMessageId: opts.originalMessageId,
      includeOriginalAttachments: opts.includeOriginalAttachments,
      forwardAsAttachment: opts.forwardAsAttachment,
      originalMessageSubject: opts.originalMessageSubject,
      originalMessageHtml: opts.originalMessageHtml,
      originalMessageText: opts.originalMessageText,
    });
    return;
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const params = new URLSearchParams();
    params.set('compose', 'true');
    params.set('mode', opts.mode ?? 'new');
    if (opts.to && opts.to.length > 0) params.set('to', formatRecipients(opts.to).join(','));
    if (opts.cc && opts.cc.length > 0) params.set('cc', formatRecipients(opts.cc).join(','));
    if (opts.bcc && opts.bcc.length > 0) params.set('bcc', formatRecipients(opts.bcc).join(','));
    if (opts.replyTo && opts.replyTo.length > 0)
      params.set('replyTo', formatRecipients(opts.replyTo).join(','));
    if (opts.subject) params.set('subject', opts.subject);
    if (opts.bodyHtml) params.set('body', btoa(unescape(encodeURIComponent(opts.bodyHtml))));
    if (opts.threadId) params.set('threadId', opts.threadId);
    if (opts.inReplyToMessageId) params.set('inReplyToMessageId', opts.inReplyToMessageId);
    if (opts.draftId) params.set('draftId', opts.draftId);
    if (opts.fromEmail) params.set('fromEmail', opts.fromEmail);
    if (opts.signatureId) params.set('signatureId', opts.signatureId);
    if (opts.classificationId) params.set('classificationId', opts.classificationId);
    params.set('isEncrypted', opts.isEncrypted ? '1' : '0');
    params.set('isSigned', opts.isSigned ? '1' : '0');
    params.set('importance', opts.importance ?? 'normal');
    params.set('requestReadReceipt', opts.requestReadReceipt ? '1' : '0');
    params.set('requestDeliveryReceipt', opts.requestDeliveryReceipt ? '1' : '0');
    if (opts.deliverAt != null) params.set('deliverAt', opts.deliverAt.toString());
    params.set('preventCopy', opts.preventCopy ? '1' : '0');
    if (opts.originalMessageId) params.set('originalMessageId', opts.originalMessageId);
    params.set('includeOriginalAttachments', opts.includeOriginalAttachments ? '1' : '0');
    params.set('forwardAsAttachment', opts.forwardAsAttachment ? '1' : '0');
    if (opts.originalMessageSubject)
      params.set('originalMessageSubject', opts.originalMessageSubject);
    if (opts.originalMessageHtml)
      params.set(
        'originalMessageHtml',
        btoa(unescape(encodeURIComponent(opts.originalMessageHtml))),
      );
    if (opts.originalMessageText)
      params.set(
        'originalMessageText',
        btoa(unescape(encodeURIComponent(opts.originalMessageText))),
      );

    const label = `compose-${Date.now()}`;
    const webview = new WebviewWindow(label, {
      url: `index.html?${params.toString()}`,
      title: opts.subject || 'New Message',
      width: 900,
      height: 760,
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
      console.log('[composeWindow] created', label);
    });
    webview.once('tauri://error', (e) => {
      console.error('[composeWindow] failed to create', e);
    });
  } catch (err) {
    console.error('[composeWindow] error opening composer window:', err);
  }
}

export function readComposeWindowParams(): ComposeWindowOptions | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('compose') !== 'true') return null;

  const decodeRecipients = (key: string): Recipient[] => {
    const raw = params.get(key);
    if (!raw) return [];
    return raw.split(',').map((email) => ({ name: email.trim(), email: email.trim() }));
  };

  const bodyParam = params.get('body');
  const bodyHtml = bodyParam ? decodeURIComponent(escape(atob(bodyParam))) : undefined;

  const importance = (params.get('importance') ?? 'normal') as Importance;

  const originalMessageHtmlParam = params.get('originalMessageHtml');
  const originalMessageHtml = originalMessageHtmlParam
    ? decodeURIComponent(escape(atob(originalMessageHtmlParam)))
    : undefined;
  const originalMessageTextParam = params.get('originalMessageText');
  const originalMessageText = originalMessageTextParam
    ? decodeURIComponent(escape(atob(originalMessageTextParam)))
    : undefined;

  return {
    mode: (params.get('mode') as ComposerMode) ?? 'new',
    to: decodeRecipients('to'),
    cc: decodeRecipients('cc'),
    bcc: decodeRecipients('bcc'),
    replyTo: decodeRecipients('replyTo'),
    subject: params.get('subject') ?? undefined,
    bodyHtml,
    threadId: params.get('threadId'),
    inReplyToMessageId: params.get('inReplyToMessageId'),
    draftId: params.get('draftId') ?? undefined,
    fromEmail: params.get('fromEmail') ?? undefined,
    signatureId: params.get('signatureId') ?? undefined,
    classificationId: params.get('classificationId') ?? undefined,
    isEncrypted: params.get('isEncrypted') === '1',
    isSigned: params.get('isSigned') === '1',
    importance,
    requestReadReceipt: params.get('requestReadReceipt') === '1',
    requestDeliveryReceipt: params.get('requestDeliveryReceipt') === '1',
    deliverAt: params.get('deliverAt') ? Number(params.get('deliverAt')) : null,
    preventCopy: params.get('preventCopy') === '1',
    originalMessageId: params.get('originalMessageId'),
    includeOriginalAttachments: params.get('includeOriginalAttachments') === '1',
    forwardAsAttachment: params.get('forwardAsAttachment') === '1',
    originalMessageSubject: params.get('originalMessageSubject') ?? undefined,
    originalMessageHtml,
    originalMessageText,
  };
}
