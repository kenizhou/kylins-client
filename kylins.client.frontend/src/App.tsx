import { useEffect, useRef, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { runMigrations } from './services/db/migrations';
import { getSetting } from './services/settings';
import { ThemeManager } from './services/theme/themeManager';
import { pluginManager } from './services/plugins/pluginManager';
import { useUIStore } from './stores/uiStore';

const themeManager = new ThemeManager();

const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useRef(true);
  const setTheme = useUIStore((s) => s.setTheme);

  useEffect(() => {
    isMounted.current = true;
    async function init() {
      try {
        if (isTauri) {
          await runMigrations();

          const savedTheme = await getSetting('theme');
          if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
            if (isMounted.current) setTheme(savedTheme);
            themeManager.applyTheme(savedTheme);
          }

          // Plugin discovery: empty for the skeleton. Real implementation will
          // scan the plugins/ directory via the Tauri fs API.
          await pluginManager.loadPlugins([]);
          await pluginManager.activatePlugins();
        }

        if (isMounted.current) setReady(true);
      } catch (err) {
        console.error('App initialization failed:', err);
        if (isMounted.current) {
          setError(describeError(err));
        }
      }
    }
    init();

    return () => {
      isMounted.current = false;
    };
  }, [setTheme]);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
        <div className="mb-4 text-lg font-semibold">Something went wrong</div>
        <div className="mb-6 max-w-md text-center text-sm opacity-80">{error}</div>
        <button
          className="rounded bg-[var(--primary)] px-4 py-2 text-[var(--primary-fg)]"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
        <div>Loading your inbox…</div>
      </div>
    );
  }

  return <AppShell />;
}
