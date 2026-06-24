import { useEffect, useRef, useState } from 'react';
import { AppShell } from './components/layout/AppShell';
import { AccountSetupFlow } from './components/account-setup/AccountSetupFlow';
import { runMigrations } from './services/db/migrations';
import { getSetting } from './services/settings';
import { getAllAccounts } from './services/accounts';
import { ThemeManager } from './services/theme/themeManager';
import { pluginManager } from './services/plugins/pluginManager';
import { useUIStore } from './stores/uiStore';
import { useAccountStore } from './stores/accountStore';
import { useViewSettings } from './features/view/hooks/useViewSettings';

const themeManager = new ThemeManager();

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Re-fetch all accounts from the DB and push them into the store. Module-level
 *  so it isn't recreated each render and can be shared by every call site. */
async function refreshAccounts(): Promise<void> {
  const refreshed = await getAllAccounts();
  useAccountStore.getState().setAccounts(refreshed);
}

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
  const [adding, setAdding] = useState(false);
  const isMounted = useRef(true);
  const setTheme = useUIStore((s) => s.setTheme);
  const accounts = useAccountStore((st) => st.accounts);
  useViewSettings();

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

          // Load existing accounts so the store knows whether to show the
          // first-run setup flow or the main shell.
          if (isMounted.current) {
            await refreshAccounts();
          }
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

  async function handleSetupComplete(): Promise<void> {
    await refreshAccounts();
    setAdding(false);
  }

  // First-run: no accounts configured yet — show the fullscreen setup flow.
  if (accounts.length === 0) {
    return <AccountSetupFlow variant="fullscreen" onComplete={handleSetupComplete} />;
  }

  return (
    <>
      <AppShell onAddAccount={() => setAdding(true)} />
      {adding && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          role="dialog"
          aria-modal="true"
          aria-label="Add account"
        >
          <div className="h-[640px] w-[680px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-xl">
            <AccountSetupFlow variant="modal" onComplete={handleSetupComplete} />
          </div>
        </div>
      )}
    </>
  );
}
