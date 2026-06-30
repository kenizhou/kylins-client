import { ReadingPane } from '@/components/layout/ReadingPane';
import { MenuBar } from '@/components/ui/MenuBar';
import { CommandRibbon } from '@/components/layout/CommandRibbon';
import { WindowTitleBar } from '@/components/ui/WindowTitleBar';
import type { MailMessage } from '@/features/view/viewStore';
import { useClassification } from '@/features/classification/useClassification';
import { WindowErrorBoundary } from '@/components/ui/WindowErrorBoundary';

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

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--background)]">
      <WindowTitleBar title={title} />

      <div className="shrink-0">
        <MenuBar variant="viewer" />
      </div>
      <CommandRibbon mode="read" />

      <div className="min-h-0 flex-1">
        <ReadingPane />
      </div>
    </div>
  );
}
