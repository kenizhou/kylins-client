import { Component, type ReactNode, useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
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
        <Button
          onPress={handleMinimize}
          className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
          aria-label="Minimize"
        >
          <MinimizeIcon size={14} />
        </Button>
        <Button
          onPress={handleToggleMaximize}
          className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
        </Button>
        <Button
          onPress={handleClose}
          className="p-1 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
          aria-label="Close window"
        >
          <CloseIcon size={14} />
        </Button>
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
          <Button
            onPress={() => window.location.reload()}
            className="rounded bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
          >
            Reload
          </Button>
          <Button
            onPress={async () => {
              try {
                await getCurrentWindow().close();
              } catch {
                /* ignore in non-Tauri contexts */
              }
            }}
            className="rounded border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
          >
            Close Window
          </Button>
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
