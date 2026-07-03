import { ReadingPane } from '@/components/layout/ReadingPane';
import { CommandRibbon } from '@/components/layout/CommandRibbon';
import { WindowTitleBar } from '@/components/ui/WindowTitleBar';
import type { MailMessage } from '@/features/view/viewStore';
import { useClassification } from '@/features/classification/useClassification';
import { WindowErrorBoundary } from '@/components/ui/WindowErrorBoundary';
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface MessageViewerWindowProps {
  message: MailMessage;
}

export function MessageViewerWindow({ message }: MessageViewerWindowProps) {
  return (
    <WindowErrorBoundary>
      <MessageViewerWindowContent message={message} />
    </WindowErrorBoundary>
  );
}

function MessageViewerWindowContent({ message }: MessageViewerWindowProps) {
  const { getLevelById } = useClassification();
  const level = message.classificationId ? getLevelById(message.classificationId) : undefined;
  const title = level
    ? `${message.subject || 'Message'} — ${level.name}`
    : message.subject || 'Message';

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | undefined;
    void listen<{ threadId: string }>('thread:deleted', (event) => {
      if (event.payload.threadId === message.threadId) {
        void getCurrentWindow().close();
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, [message.threadId]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--background)]">
      <WindowTitleBar title={title} />

      <CommandRibbon mode="read" viewer />

      <div className="min-h-0 flex-1">
        <ReadingPane />
      </div>
    </div>
  );
}
