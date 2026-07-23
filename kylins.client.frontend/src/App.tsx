import { useEffect, useRef, useState } from 'react';
import { I18nProvider } from 'react-aria-components';
import { AppShell } from './components/layout/AppShell';
import { AccountSetupFlow } from './components/account-setup/AccountSetupFlow';
import { PreferencesDialog } from './components/preferences/PreferencesDialog';
import { Composer } from './components/composer/Composer';
import { Modal } from './components/ui/Modal';
import { getSetting } from './services/settings';
import { getAllAccounts, deleteAccountByEmail } from './services/accounts';
import { themeManager } from './services/theme/themeManager';
import { onAppearanceChange } from './services/theme/appearanceSync';
import { pluginManager } from './services/plugins/pluginManager';
import { activateBuiltInPlugins } from './services/plugins/builtInPlugins';
import { useUIStore, type ContrastMode } from './stores/uiStore';
import { useAccountStore } from './stores/accountStore';
import { useFolderStore } from './stores/folderStore';
import { useAccountSetupStore } from './stores/accountSetupStore';
import { useComposerStore } from './stores/composerStore';
import { usePreferencesStore } from './stores/preferencesStore';
import { useViewStore } from './features/view/viewStore';
import { useViewSettings } from './features/view/hooks/useViewSettings';
import { readComposeWindowParams } from './utils/composeWindow';
import { readViewerWindowParams } from './utils/viewerWindow';
import { MessageViewerWindow } from './components/viewer/MessageViewerWindow';
import { Toaster } from './components/ui/Toaster';
import { UserIcon } from './components/icons';
import { isSkinId, DEFAULT_SKIN, type SkinId } from './styles/skins';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useSyncEvents } from './hooks/useSyncEvents';
import { useShortcutStore } from './stores/shortcutStore';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Re-fetch all accounts from the DB and push them into the store. Module-level
 *  so it isn't recreated each render and can be shared by every call site. */
async function refreshAccounts(): Promise<void> {
  const refreshed = await getAllAccounts();
  useAccountStore.getState().setAccounts(refreshed);
}

/** Window-bar title for the account-setup modal, per setup step. */
const SETUP_STEP_TITLES: Record<string, string> = {
  pick: 'Add account',
  gateway: 'Add account',
  'oauth-pending': 'Sign in',
  'imap-manual': 'Manual setup',
  'eas-manual': 'Manual setup',
  verifying: 'Connecting',
  welcome: 'Account added',
  error: 'Connection failed',
};

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function hydrateBackground(
  applyAppearance: (
    theme: string | null,
    skin: string | null,
    contrast: string | null,
    fontSize: string | null,
    serifSubjects: string | null,
    reduceMotion: string | null,
  ) => void,
  options: { refreshAccountsToo?: boolean } = {},
): void {
  const { refreshAccountsToo = true } = options;
  if (refreshAccountsToo) {
    refreshAccounts().catch((err) => console.error('Background account refresh failed:', err));
  }

  Promise.all([
    getSetting('theme'),
    getSetting('skin'),
    getSetting('contrast'),
    getSetting('font_size'),
    getSetting('serif_subjects'),
    getSetting('reduce_motion'),
  ])
    .then(
      ([
        savedTheme,
        savedSkin,
        savedContrast,
        savedFontSize,
        savedSerifSubjects,
        savedReduceMotion,
      ]) =>
        applyAppearance(
          savedTheme,
          savedSkin,
          savedContrast,
          savedFontSize,
          savedSerifSubjects,
          savedReduceMotion,
        ),
    )
    .catch(() => {
      /* ignore: appearance is cosmetic */
    });

  useShortcutStore
    .getState()
    .hydrate()
    .catch(() => {
      /* ignore: shortcuts are optional at startup */
    });

  usePreferencesStore
    .getState()
    .hydrate()
    .catch(() => {
      /* ignore: preferences are optional at startup */
    });
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useRef(true);
  const composeParams = readComposeWindowParams();
  const isComposeWindow = composeParams !== null;
  const viewerParams = readViewerWindowParams();
  const isViewerWindow = viewerParams !== null;
  const setTheme = useUIStore((s) => s.setTheme);
  const setContrast = useUIStore((s) => s.setContrast);
  const setSkin = useUIStore((s) => s.setSkin);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const setSerifSubjects = useUIStore((s) => s.setSerifSubjects);
  const setReduceMotion = useUIStore((s) => s.setReduceMotion);
  const accountSetupOpen = useUIStore((s) => s.accountSetupOpen);
  const setAccountSetupOpen = useUIStore((s) => s.setAccountSetupOpen);
  const setupStep = useAccountSetupStore((s) => s.step);
  const accounts = useAccountStore((s) => s.accounts);
  const interfaceLanguage = usePreferencesStore((s) => s.interfaceLanguage);
  useViewSettings();
  useKeyboardShortcuts();
  useSyncEvents();

  // Dev-only helper to recover from corrupt/duplicate test accounts.
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__deleteAccountByEmail = deleteAccountByEmail;
    }
  }, []);

  // Appearance changes broadcast from any window (e.g. Preferences in the main
  // window) are re-applied here so pop-out windows (composer, viewer) follow
  // theme/contrast/skin switches live.
  useEffect(() => {
    if (!isTauri) return;
    return onAppearanceChange(({ key, value }) => {
      switch (key) {
        case 'theme':
          if (value === 'light' || value === 'dark' || value === 'system') {
            setTheme(value);
            themeManager.applyTheme(value);
          }
          break;
        case 'contrast': {
          const resolved: ContrastMode = value === 'high' ? 'high' : 'default';
          setContrast(resolved);
          themeManager.setContrast(resolved);
          break;
        }
        case 'skin':
          if (isSkinId(value)) {
            setSkin(value);
            themeManager.applySkin(value);
          }
          break;
        case 'font_size': {
          const resolved = value === 'small' || value === 'large' ? value : 'default';
          setFontSize(resolved);
          themeManager.setFontSize(resolved);
          break;
        }
        case 'serif_subjects': {
          const enabled = value === 'true';
          setSerifSubjects(enabled);
          themeManager.setSerifSubjects(enabled);
          break;
        }
        case 'reduce_motion': {
          const enabled = value === 'true';
          setReduceMotion(enabled);
          themeManager.setReduceMotion(enabled);
          break;
        }
      }
    });
  }, [setTheme, setContrast, setSkin, setFontSize, setSerifSubjects, setReduceMotion]);

  useEffect(() => {
    isMounted.current = true;

    function applyAppearance(
      theme: string | null,
      skin: string | null,
      contrast: string | null,
      fontSize: string | null,
      serifSubjects: string | null,
      reduceMotion: string | null,
    ): void {
      if (theme === 'light' || theme === 'dark' || theme === 'system') {
        if (isMounted.current) setTheme(theme);
        themeManager.applyTheme(theme);
      }
      const resolvedContrast: ContrastMode = contrast === 'high' ? 'high' : 'default';
      if (isMounted.current) setContrast(resolvedContrast);
      themeManager.setContrast(resolvedContrast);

      const resolvedSkin: SkinId = skin && isSkinId(skin) ? skin : DEFAULT_SKIN;
      if (isMounted.current) setSkin(resolvedSkin);
      themeManager.applySkin(resolvedSkin);

      const resolvedFontSize: 'small' | 'default' | 'large' =
        fontSize === 'small' || fontSize === 'large' ? fontSize : 'default';
      if (isMounted.current) setFontSize(resolvedFontSize);
      themeManager.setFontSize(resolvedFontSize);

      const resolvedSerifSubjects = serifSubjects === 'true';
      if (isMounted.current) setSerifSubjects(resolvedSerifSubjects);
      themeManager.setSerifSubjects(resolvedSerifSubjects);

      const resolvedReduceMotion = reduceMotion === 'true';
      if (isMounted.current) setReduceMotion(resolvedReduceMotion);
      themeManager.setReduceMotion(resolvedReduceMotion);
    }

    async function init() {
      try {
        if (isTauri) {
          if (isComposeWindow) {
            // Composer pop-out window: skip the heavy main-window startup
            // (migrations, plugin load, full account refresh). Just hydrate the
            // composer state from the URL params and become ready.

            // Accounts must be loaded + the active account set so the composer's
            // sendEmail(activeAccountId, …) resolves a real account. The main
            // window does this in its full startup; the popout skips that, so do
            // the minimum here. Without this, handleSend passes null accountId
            // and the send aborts with "No account found for id null" (and the
            // auto-saved draft is never deleted as a result).
            await refreshAccounts();
            const targetAccountId =
              composeParams?.accountId ?? useAccountStore.getState().accounts[0]?.id ?? null;
            if (targetAccountId) {
              useAccountStore.getState().setActiveAccount(targetAccountId);
            }

            if (isMounted.current && composeParams) {
              useComposerStore.getState().openComposer({
                mode: composeParams.mode,
                to: composeParams.to,
                cc: composeParams.cc,
                bcc: composeParams.bcc,
                replyTo: composeParams.replyTo,
                subject: composeParams.subject,
                bodyHtml: composeParams.bodyHtml,
                threadId: composeParams.threadId,
                inReplyToMessageId: composeParams.inReplyToMessageId,
                draftId: composeParams.draftId,
                fromEmail: composeParams.fromEmail,
                signatureId: composeParams.signatureId,
                classificationId: composeParams.classificationId,
                isEncrypted: composeParams.isEncrypted,
                isSigned: composeParams.isSigned,
                importance: composeParams.importance,
                requestReadReceipt: composeParams.requestReadReceipt,
                requestDeliveryReceipt: composeParams.requestDeliveryReceipt,
                deliverAt: composeParams.deliverAt,
                preventCopy: composeParams.preventCopy,
                originalMessageId: composeParams.originalMessageId,
                includeOriginalAttachments: composeParams.includeOriginalAttachments,
                forwardAsAttachment: composeParams.forwardAsAttachment,
                originalMessageSubject: composeParams.originalMessageSubject,
                originalMessageHtml: composeParams.originalMessageHtml,
                originalMessageText: composeParams.originalMessageText,
                stagingDraftId: composeParams.stagingDraftId,
                attachments: composeParams.attachments,
              });
            }

            // Hydrate everything in the background; don't block the composer UI.
            // (Accounts were already refreshed above — skip the duplicate read.)
            hydrateBackground(applyAppearance, { refreshAccountsToo: false });
          } else if (isViewerWindow) {
            // Viewer pop-out window: skip heavy startup. Hydrate the selected
            // message from the URL params and become ready immediately.
            if (isMounted.current && viewerParams) {
              useViewStore.getState().setSelectedMessage(viewerParams);
            }

            hydrateBackground(applyAppearance);
          } else {
            // Rust runs the embedded sqlx migrations on startup (db::init_db in
            // lib.rs setup), so the frontend no longer calls runMigrations.

            const [
              savedTheme,
              savedSkin,
              savedContrast,
              savedFontSize,
              savedSerifSubjects,
              savedReduceMotion,
            ] = await Promise.all([
              getSetting('theme'),
              getSetting('skin'),
              getSetting('contrast'),
              getSetting('font_size'),
              getSetting('serif_subjects'),
              getSetting('reduce_motion'),
            ]);
            applyAppearance(
              savedTheme,
              savedSkin,
              savedContrast,
              savedFontSize,
              savedSerifSubjects,
              savedReduceMotion,
            );

            await Promise.all([
              useShortcutStore.getState().hydrate(),
              usePreferencesStore.getState().hydrate(),
            ]);

            // Plugin discovery: load any previously installed plugins, then activate.
            await pluginManager.loadInstalledPlugins();
            activateBuiltInPlugins();

            // Load existing accounts into the store so the UI reflects any
            // already-configured accounts on startup.
            if (isMounted.current) {
              await refreshAccounts();
              // Start the Rust SyncEngine (one polling worker per account). The engine
              // emits sync:* events; useSyncEvents() below refreshes stores on them.
              await invoke('sync_start').catch((err) => console.error('sync_start failed:', err));
            }
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
  }, [setTheme, setContrast, setSkin, setFontSize, setSerifSubjects, setReduceMotion]);

  // Load folders (labels) + unread counts + favorites whenever the account set
  // changes. Covers initial startup (after refreshAccounts populates the store)
  // and add/remove account. No-op until there are accounts to load.
  useEffect(() => {
    if (accounts.length === 0) return;
    useFolderStore
      .getState()
      .loadLabels()
      .catch((err) => console.error('Folder load failed:', err));
  }, [accounts]);

  async function handleSetupComplete(): Promise<void> {
    await refreshAccounts();
    setAccountSetupOpen(false);
  }

  function handleCloseSetup(): void {
    useAccountSetupStore.getState().reset();
    setAccountSetupOpen(false);
  }

  // Catch-all: in a composer pop-out, if the composer state closes but the
  // window somehow survived (e.g. a close path that failed silently), destroy
  // the window rather than leaving a blank white frame behind.
  useEffect(() => {
    if (!isTauri || !isComposeWindow || !ready) return;
    return useComposerStore.subscribe((s) => {
      if (!s.isOpen) {
        getCurrentWindow()
          .destroy()
          .catch((err) => console.error('[App] composer catch-all destroy failed:', err));
      }
    });
  }, [ready, isComposeWindow]);

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

  return (
    <I18nProvider locale={interfaceLanguage === 'automatic' ? undefined : interfaceLanguage}>
      {isComposeWindow ? (
        <>
          <Composer windowed />
          <Toaster />
        </>
      ) : isViewerWindow ? (
        <>
          <MessageViewerWindow message={viewerParams!} />
          <Toaster />
        </>
      ) : (
        <>
          <AppShell />
          <PreferencesDialog />
          <Modal
            isOpen={accountSetupOpen}
            onClose={handleCloseSetup}
            disableBackdropClose
            size="auto"
            title={SETUP_STEP_TITLES[setupStep] ?? 'Add account'}
            subtitle="Connect an email account to Kylins"
            icon={UserIcon}
            contentClassName="bg-[var(--background)]"
          >
            <AccountSetupFlow variant="modal" onComplete={handleSetupComplete} />
          </Modal>
          <Toaster />
        </>
      )}
    </I18nProvider>
  );
}
