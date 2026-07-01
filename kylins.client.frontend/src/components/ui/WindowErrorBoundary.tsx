import { Component, type ReactNode, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon } from '@/components/icons';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

const dragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'drag',
};
const noDragStyle: React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' } = {
  WebkitAppRegion: 'no-drag',
};

function EmergencyTitleBar({ title }: { title?: string }) {
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
    <div
      className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 select-none"
      style={dragStyle}
    >
      <span className="truncate text-sm font-medium text-[var(--foreground)]">
        {title ?? 'Kylins'}
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
          aria-label="Close window"
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}

function ErrorFallback({ error }: { error?: Error }) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <EmergencyTitleBar title="Something went wrong" />
      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
        <div className="mb-2 text-lg font-semibold">This window encountered an error</div>
        <div className="mb-6 max-w-md text-sm opacity-80">
          {error?.message ?? 'An unexpected error occurred.'}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.location.reload()}
            className="rounded bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-fg)]"
          >
            Reload
          </button>
          <button
            onClick={async () => {
              try {
                await getCurrentWindow().close();
              } catch {
                /* ignore in non-Tauri contexts */
              }
            }}
            className="rounded border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--hover)]"
          >
            Close Window
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Error boundary for pop-out windows. If any child throws during render, the
 * window chrome (title bar + close/minimize/maximize controls) is still rendered
 * so the user can close the broken window instead of being stuck.
 */
export class WindowErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[WindowErrorBoundary] caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}
