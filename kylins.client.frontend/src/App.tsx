import { useEffect, useRef, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { runMigrations } from './services/db/migrations';
import { getSetting } from './services/settings';
import { ThemeManager } from './services/theme/themeManager';
import { pluginManager } from './services/plugins/pluginManager';
import { useUIStore } from './stores/uiStore';
import { invoke } from '@tauri-apps/api/core';

const themeManager = new ThemeManager();

async function discoverPlugins(): Promise<string[]> {
  // In a real app this scans the plugins/ directory via Tauri fs API.
  // For the skeleton, return an empty list; the example plugin is loaded manually in dev.
  return [];
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useRef(true);
  const setTheme = useUIStore((s) => s.setTheme);

  useEffect(() => {
    async function init() {
      try {
        await runMigrations();

        const savedTheme = await getSetting('theme');
        if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
          if (isMounted.current) setTheme(savedTheme);
          themeManager.applyTheme(savedTheme);
        }

        const pluginPaths = await discoverPlugins();
        await pluginManager.loadPlugins(pluginPaths);
        await pluginManager.activatePlugins();

        // Close splash screen if running in Tauri
        invoke('close_splashscreen').catch(() => {});

        if (isMounted.current) setReady(true);
      } catch (err) {
        console.error('App initialization failed:', err);
        if (isMounted.current) {
          setError(err instanceof Error ? err.message : 'Initialization failed');
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
          className="rounded bg-[var(--color-accent)] px-4 py-2 text-white"
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
