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
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Mock the services and stores App.tsx pulls in at module scope.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

vi.mock('../src/services/db/migrations', () => ({ runMigrations: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/services/settings', () => ({ getSetting: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../src/services/accounts', () => ({
  getAllAccounts: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../src/services/theme/themeManager', () => ({
  ThemeManager: class {
    applyTheme = vi.fn();
  },
}));
vi.mock('../src/services/plugins/pluginManager', () => ({
  pluginManager: {
    loadPlugins: vi.fn(() => Promise.resolve()),
    activatePlugins: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('../src/features/view/hooks/useViewSettings', () => ({ useViewSettings: vi.fn() }));

// Mock AppShell so we don't pull in the full layout (and its Tauri deps).
vi.mock('../src/components/layout/AppShell', () => ({
  AppShell: ({ onAddAccount }: { onAddAccount?: () => void }) => (
    <div>
      <span>AppShell</span>
      {onAddAccount && (
        <button type="button" onClick={onAddAccount}>
          add-account-trigger
        </button>
      )}
    </div>
  ),
}));

import App from '../src/App';
import { getAllAccounts } from '../src/services/accounts';
import { useAccountStore } from '../src/stores/accountStore';

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
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the AccountSetupFlow when there are no accounts (first-run)', async () => {
    vi.mocked(getAllAccounts).mockResolvedValue([]);
    render(<App />);
    // AccountSetupFlow renders the picker with "Add an account" heading.
    expect(await screen.findByText('Add an account')).toBeInTheDocument();
  });

  it('shows AppShell with an Add-account trigger once an account exists', async () => {
    vi.mocked(getAllAccounts).mockResolvedValue([makeAccount('a1')]);
    render(<App />);
    expect(await screen.findByText('AppShell')).toBeInTheDocument();
    expect(screen.getByText('add-account-trigger')).toBeInTheDocument();
  });

  it('opens the modal setup flow when the Add-account trigger is clicked', async () => {
    vi.mocked(getAllAccounts).mockResolvedValue([makeAccount('a1')]);
    render(<App />);
    await screen.findByText('AppShell');
    fireEvent.click(screen.getByText('add-account-trigger'));
    // Modal overlay renders a second AccountSetupFlow instance ("Add an account").
    const pickers = await screen.findAllByText('Add an account');
    expect(pickers.length).toBeGreaterThanOrEqual(1);
  });
});
