import { type Recipient } from '@/features/composer/contacts';
import { formatRecipients } from '@/features/composer/contacts';
import type { ComposerMode } from '@/stores/composerStore';

export interface ComposeWindowOptions {
  mode?: ComposerMode;
  to?: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  subject?: string;
  bodyHtml?: string;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  draftId?: string | null;
  fromEmail?: string | null;
  signatureId?: string | null;
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
      subject: opts.subject,
      bodyHtml: opts.bodyHtml,
      threadId: opts.threadId,
      inReplyToMessageId: opts.inReplyToMessageId,
      draftId: opts.draftId,
      fromEmail: opts.fromEmail,
      signatureId: opts.signatureId,
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
    if (opts.subject) params.set('subject', opts.subject);
    if (opts.bodyHtml) params.set('body', btoa(unescape(encodeURIComponent(opts.bodyHtml))));
    if (opts.threadId) params.set('threadId', opts.threadId);
    if (opts.inReplyToMessageId) params.set('inReplyToMessageId', opts.inReplyToMessageId);
    if (opts.draftId) params.set('draftId', opts.draftId);
    if (opts.fromEmail) params.set('fromEmail', opts.fromEmail);
    if (opts.signatureId) params.set('signatureId', opts.signatureId);

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
  const bodyHtml = bodyParam
    ? decodeURIComponent(escape(atob(bodyParam)))
    : undefined;

  return {
    mode: (params.get('mode') as ComposerMode) ?? 'new',
    to: decodeRecipients('to'),
    cc: decodeRecipients('cc'),
    bcc: decodeRecipients('bcc'),
    subject: params.get('subject') ?? undefined,
    bodyHtml,
    threadId: params.get('threadId'),
    inReplyToMessageId: params.get('inReplyToMessageId'),
    draftId: params.get('draftId') ?? undefined,
    fromEmail: params.get('fromEmail') ?? undefined,
    signatureId: params.get('signatureId') ?? undefined,
  };
}
