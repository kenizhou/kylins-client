// App.tsx reads `isTauri` at module load (`'__TAURI_INTERNALS__' in window`),
// so the sentinel must be present BEFORE the App module is imported. vi.hoisted
// runs before the test file's imports are resolved, satisfying that ordering.
vi.hoisted(() => {
  if (typeof window !== 'undefined') {
    (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ =
      {};
  }
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Mock the services and stores App.tsx pulls in at module scope.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

vi.mock('../src/services/db/migrations', () => ({ runMigrations: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/services/settings', () => ({ getSetting: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../src/services/accounts', () => ({
  getAllAccounts: vi.fn(() => Promise.resolve([])),
  deleteAccountByEmail: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/services/theme/themeManager', () => ({
  themeManager: {
    applyTheme: vi.fn(),
    applySkin: vi.fn(),
    resetSkin: vi.fn(),
  },
}));
vi.mock('../src/services/plugins/pluginManager', () => ({
  pluginManager: {
    loadInstalledPlugins: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../src/features/view/hooks/useViewSettings', () => ({ useViewSettings: vi.fn() }));

// Mock AppShell so we don't pull in the full layout (and its Tauri deps). The
// "+ Add account" affordance moved out of AppShell into the File menu, which
// drives `uiStore.accountSetupOpen`; AppShell no longer takes an onAddAccount prop.
vi.mock('../src/components/layout/AppShell', () => ({
  AppShell: () => (
    <div>
      <span>AppShell</span>
    </div>
  ),
}));

import App from '../src/App';
import { getAllAccounts } from '../src/services/accounts';
import { useAccountStore } from '../src/stores/accountStore';
import { useUIStore } from '../src/stores/uiStore';

function makeAccount(id: string) {
  return {
    id,
    email: 'user@example.com',
    provider: 'imap' as const,
    isActive: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('App', () => {
  beforeEach(() => {
    useAccountStore.getState().setAccounts([]);
    useUIStore.getState().setAccountSetupOpen(false);
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows AppShell even when there are no accounts (setup can be opened later)', async () => {
    vi.mocked(getAllAccounts).mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByText('AppShell')).toBeInTheDocument();
  });

  it('shows AppShell once an account exists', async () => {
    vi.mocked(getAllAccounts).mockResolvedValue([makeAccount('a1')]);
    render(<App />);
    expect(await screen.findByText('AppShell')).toBeInTheDocument();
  });

  it('opens the modal setup flow when account setup is requested (File menu → uiStore)', async () => {
    vi.mocked(getAllAccounts).mockResolvedValue([makeAccount('a1')]);
    render(<App />);
    await screen.findByText('AppShell');
    // The File menu sets this flag; simulate it directly here (AppShell is
    // mocked, so the real MenuBar isn't reachable in this test).
    useUIStore.getState().setAccountSetupOpen(true);
    // Modal overlay renders the AccountSetupFlow.
    const pickers = await screen.findAllByText('Welcome to Kylins Mail');
    expect(pickers.length).toBeGreaterThanOrEqual(1);
  });
});
