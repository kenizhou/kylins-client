import type { MailMessage } from '@/features/view/viewStore';

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function encodeMessage(message: MailMessage): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(message))));
}

function decodeMessage(data: string): MailMessage {
  return JSON.parse(decodeURIComponent(escape(atob(data)))) as MailMessage;
}

/**
 * Opens the selected message in a dedicated, resizable viewer window.
 * Falls back to setting the selected message in the current window when not
 * running under Tauri (e.g. tests).
 */
export async function openViewerWindow(message: MailMessage): Promise<void> {
  if (!isTauriEnv()) {
    const { useViewStore } = await import('@/features/view/viewStore');
    useViewStore.getState().setSelectedMessage(message);
    return;
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const params = new URLSearchParams();
    params.set('view', 'message');
    params.set('data', encodeMessage(message));

    const label = `viewer-${message.id}-${Date.now()}`;
    const webview = new WebviewWindow(label, {
      url: `index.html?${params.toString()}`,
      title: message.subject || 'Message',
      width: 900,
      height: 700,
      minWidth: 600,
      minHeight: 400,
      center: true,
      decorations: false,
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
    });

    webview.once('tauri://created', () => {
      console.log('[viewerWindow] created', label);
    });
    webview.once('tauri://error', (e) => {
      console.error('[viewerWindow] failed to create', e);
    });
  } catch (err) {
    console.error('[viewerWindow] error opening viewer window:', err);
  }
}

export function readViewerWindowParams(): MailMessage | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') !== 'message') return null;

  const data = params.get('data');
  if (!data) return null;

  try {
    return decodeMessage(data);
  } catch (err) {
    console.error('[viewerWindow] failed to decode viewer params:', err);
    return null;
  }
}
