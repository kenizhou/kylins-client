import { useEffect, useState } from 'react';
import { ToggleButton, Button } from 'react-aria-components';
import { useAccountStore } from '../../stores/accountStore';
import { useAccountSetupStore } from '../../stores/accountSetupStore';
import { getAllAccounts } from '../../services/accounts';
import { AccountSetupFlow } from '../account-setup/AccountSetupFlow';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { PreferencesTabLayout } from './PreferencesTabLayout';
import { AccountDetailsEditor } from './AccountDetailsEditor';
import { KeyManagerSection } from './KeyManagerSection';
import { ProviderBadge } from './ProviderBadge';
import { PreferencesAccountsIcon, PlusIcon, CloseIcon } from '../icons';

export function AccountsPreferences() {
  const accounts = useAccountStore((s) => s.accounts);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const effectiveAccountId = selectedAccountId ?? accounts[0]?.id ?? null;
  const selectedAccount = accounts.find((a) => a.id === effectiveAccountId) ?? null;

  async function refresh() {
    setIsLoading(true);
    try {
      const refreshed = await getAllAccounts();
      useAccountStore.getState().setAccounts(refreshed);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    // If the store is empty on first load, try to hydrate from the database.
    if (accounts.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleOpenSetup() {
    useAccountSetupStore.getState().reset();
    setShowSetup(true);
  }

  function handleSetupComplete() {
    setShowSetup(false);
    void refresh();
  }

  function handleCloseSetup() {
    setShowSetup(false);
    useAccountSetupStore.getState().reset();
  }

  if (accounts.length === 0 && !isLoading) {
    return (
      <PreferencesTabLayout>
        <PreferencesSectionCard title="Accounts" icon={PreferencesAccountsIcon}>
          <p className="text-sm text-[var(--muted-text)] mb-4">No accounts configured yet.</p>
          <Button
            onPress={handleOpenSetup}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            Add account
          </Button>

          {showSetup && (
            <SetupOverlay onClose={handleCloseSetup} onComplete={handleSetupComplete} />
          )}
        </PreferencesSectionCard>
      </PreferencesTabLayout>
    );
  }

  return (
    <PreferencesTabLayout>
      <PreferencesSectionCard title="Accounts" icon={PreferencesAccountsIcon}>
        <div className="flex flex-wrap items-center gap-2 mb-5">
          {accounts.map((account) => {
            const active = account.id === effectiveAccountId;
            return (
              <ToggleButton
                key={account.id}
                isSelected={active}
                onPress={() => setSelectedAccountId(account.id)}
                className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] selected:border-[var(--primary)] selected:bg-[var(--selected)] selected:text-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <ProviderBadge
                  provider={account.provider}
                  setupProviderId={account.setupProviderId}
                />
                <span className="truncate max-w-[180px]">
                  {account.accountLabel || account.email}
                </span>
                {account.isDefault && (
                  <span className="inline-flex items-center rounded-full bg-[var(--highlight)] px-2 py-0.5 text-[10px] font-medium text-[var(--highlight-text)]">
                    Default
                  </span>
                )}
                {!account.isActive && (
                  <span className="inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--muted-foreground),transparent_88%)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]">
                    Paused
                  </span>
                )}
              </ToggleButton>
            );
          })}
          <Button
            onPress={handleOpenSetup}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <PlusIcon size={14} />
            Add account
          </Button>
        </div>

        {selectedAccount ? (
          <AccountDetailsEditor
            key={selectedAccount.id}
            account={selectedAccount}
            onUpdate={() => void refresh()}
          />
        ) : (
          <p className="text-sm text-[var(--muted-text)]">
            Select an account to view and edit its details.
          </p>
        )}
      </PreferencesSectionCard>

      {selectedAccount && <KeyManagerSection accountId={selectedAccount.id} />}

      {showSetup && <SetupOverlay onClose={handleCloseSetup} onComplete={handleSetupComplete} />}
    </PreferencesTabLayout>
  );
}

function SetupOverlay({ onClose, onComplete }: { onClose: () => void; onComplete: () => void }) {
  return (
    <div className="fixed inset-0 z-[var(--z-modal-backdrop)] bg-[var(--background)]">
      <Button
        onPress={onClose}
        className="absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <CloseIcon size={14} />
        Cancel
      </Button>
      <AccountSetupFlow variant="modal" onComplete={onComplete} />
    </div>
  );
}
