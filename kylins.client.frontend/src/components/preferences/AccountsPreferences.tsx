import { useEffect, useState } from 'react';
import { useAccountStore } from '../../stores/accountStore';
import { useAccountSetupStore } from '../../stores/accountSetupStore';
import { getAllAccounts } from '../../services/accounts';
import { AccountSetupFlow } from '../account-setup/AccountSetupFlow';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { PreferencesTabLayout, PreferencesTabColumns } from './PreferencesTabLayout';
import { AccountDetailsEditor } from './AccountDetailsEditor';
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
          <p className="text-sm text-[var(--muted-text)] mb-4">
            No accounts configured yet.
          </p>
          <button
            type="button"
            onClick={handleOpenSetup}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity"
          >
            Add account
          </button>

          {showSetup && (
            <SetupOverlay onClose={handleCloseSetup} onComplete={handleSetupComplete} />
          )}
        </PreferencesSectionCard>
      </PreferencesTabLayout>
    );
  }

  return (
    <PreferencesTabLayout>
      <PreferencesTabColumns
        left={
          <>
            <PreferencesSectionCard title="Your accounts" icon={PreferencesAccountsIcon}>
            {isLoading ? (
              <div className="text-sm text-[var(--muted-text)]">Loading…</div>
            ) : accounts.length === 0 ? (
              <div className="text-sm text-[var(--muted-text)]">No accounts configured.</div>
            ) : (
              <ul className="space-y-2">
                {accounts.map((account) => {
                  const active = account.id === effectiveAccountId;
                  return (
                    <li
                      key={account.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedAccountId(account.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedAccountId(account.id);
                        }
                      }}
                      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                        active
                          ? 'border-[var(--primary)] bg-[color-mix(in_oklab,var(--primary),transparent_92%)]'
                          : 'border-[var(--border)] bg-[var(--background)] hover:bg-[var(--hover)]'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <ProviderBadge
                          provider={account.provider}
                          setupProviderId={account.setupProviderId}
                        />
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-medium text-[var(--foreground)] truncate">
                            {account.accountLabel || account.displayName || account.email}
                          </span>
                          <span className="text-xs text-[var(--muted-text)] truncate">{account.email}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {account.isDefault && (
                          <span className="inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--primary),transparent_88%)] px-2 py-0.5 text-[10px] font-medium text-[var(--primary)]">
                            Default
                          </span>
                        )}
                        {!account.isActive && (
                          <span className="inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--muted-foreground),transparent_88%)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]">
                            Paused
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <button
              type="button"
              onClick={handleOpenSetup}
              className="mt-4 flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
            >
              <PlusIcon size={14} />
              Add account
            </button>
          </PreferencesSectionCard>
          </>
        }
        right={
          <>
            {selectedAccount ? (
            <AccountDetailsEditor
              key={selectedAccount.id}
              account={selectedAccount}
              onUpdate={() => void refresh()}
            />
          ) : (
            <PreferencesSectionCard title="Account details" icon={PreferencesAccountsIcon}>
              <p className="text-sm text-[var(--muted-text)]">Select an account to view details.</p>
            </PreferencesSectionCard>
          )}
          </>
        }
      />

      {showSetup && (
        <SetupOverlay onClose={handleCloseSetup} onComplete={handleSetupComplete} />
      )}
    </PreferencesTabLayout>
  );
}

function SetupOverlay({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-[var(--background)]">
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
      >
        <CloseIcon size={14} />
        Cancel
      </button>
      <AccountSetupFlow variant="modal" onComplete={onComplete} />
    </div>
  );
}
