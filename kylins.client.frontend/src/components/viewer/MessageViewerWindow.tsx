import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ReadingPane } from '@/components/layout/ReadingPane';
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon } from '@/components/icons';
import type { MailMessage } from '@/features/view/viewStore';

const dragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'drag',
};
const noDragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'no-drag',
};

interface MessageViewerWindowProps {
  message: MailMessage;
}

export function MessageViewerWindow({ message }: MessageViewerWindowProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    async function init() {
      setIsMaximized(await appWindow.isMaximized());
      unlisten = await appWindow.onResized(async () => {
        setIsMaximized(await appWindow.isMaximized());
      });
    }
    init();

    return () => {
      unlisten?.();
    };
  }, []);

  const handleMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      /* ignore in non-Tauri contexts */
    }
  };

  const handleToggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch {
      /* ignore in non-Tauri contexts */
    }
  };

  const handleClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore in non-Tauri contexts */
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--background)]">
      {/* Custom titlebar */}
      <div
        className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 select-none"
        style={dragStyle}
      >
        <span className="truncate text-sm font-medium text-[var(--foreground)]">
          {message.subject || 'Message'}
        </span>
        <div className="flex items-center gap-1" style={noDragStyle}>
          <button
            type="button"
            onClick={handleMinimize}
            className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            title="Minimize"
            aria-label="Minimize"
          >
            <MinimizeIcon size={14} />
          </button>
          <button
            type="button"
            onClick={handleToggleMaximize}
            className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            title={isMaximized ? 'Restore' : 'Maximize'}
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="p-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            aria-label="Close viewer"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ReadingPane />
      </div>
    </div>
  );
}
