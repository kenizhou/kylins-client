import { useState } from 'react';
import type { Account } from '../../types';
import {
  updateAccount,
  setDefaultAccount,
  deleteAccount,
} from '../../services/accounts';
import {
  reauthorizeAccount,
  testImapConnection,
  testEasConnection,
} from '../../services/auth/accountSetupFlows';
import { useAccountStore } from '../../stores/accountStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { ProviderBadge } from './ProviderBadge';
import { AliasManager } from './AliasManager';
import { PreferencesAccountsIcon, TrashIcon } from '../icons';

function statusColorClass(type: string): string {
  if (type === 'success') return 'text-green-600';
  if (type === 'error') return 'text-[var(--destructive)]';
  return 'text-[var(--muted-text)]';
}

interface AccountDetailsEditorProps {
  account: Account;
  onUpdate: () => void;
}

function ReadOnlyField({ label, value }: { label: string; value?: string | number | null }) {
  const display = value === undefined || value === null || value === '' ? '—' : String(value);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-[var(--muted-text)]">{label}</span>
      <span className="text-sm text-[var(--foreground)] font-mono truncate">{display}</span>
    </div>
  );
}

export function AccountDetailsEditor({ account, onUpdate }: AccountDetailsEditorProps) {
  const [accountLabel, setAccountLabel] = useState(account.accountLabel ?? '');
  const [displayName, setDisplayName] = useState(account.displayName ?? '');
  const [isSavingIdentity, setIsSavingIdentity] = useState(false);
  const [testStatus, setTestStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; message: string }>({
    type: 'idle',
    message: '',
  });
  const [reauthStatus, setReauthStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; message: string }>({
    type: 'idle',
    message: '',
  });

  async function handleSaveIdentity(e: React.FormEvent) {
    e.preventDefault();
    setIsSavingIdentity(true);
    try {
      await updateAccount(account.id, {
        accountLabel: accountLabel.trim() || undefined,
        displayName: displayName.trim() || undefined,
      });
      useAccountStore.getState().updateAccountInPlace(account.id, {
        accountLabel: accountLabel.trim() || undefined,
        displayName: displayName.trim() || undefined,
      });
      onUpdate();
    } finally {
      setIsSavingIdentity(false);
    }
  }

  async function handleToggleActive() {
    const next = !account.isActive;
    await updateAccount(account.id, { isActive: next });
    useAccountStore.getState().updateAccountInPlace(account.id, { isActive: next });
    onUpdate();
  }

  async function handleSetDefault() {
    await setDefaultAccount(account.id);
    useAccountStore.getState().setDefaultAccountId(account.id);
    onUpdate();
  }

  async function handleTestConnection() {
    setTestStatus({ type: 'loading', message: 'Testing connection…' });
    try {
      if (account.provider === 'eas') {
        await testEasConnection(account);
      } else {
        await testImapConnection(account);
      }
      setTestStatus({ type: 'success', message: 'Connection succeeded.' });
    } catch (err) {
      setTestStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Connection failed.',
      });
    }
  }

  async function handleReauthorize() {
    setReauthStatus({ type: 'loading', message: 'Opening browser for re-authorization…' });
    try {
      await reauthorizeAccount(account);
      setReauthStatus({ type: 'success', message: 'Re-authorized successfully.' });
      onUpdate();
    } catch (err) {
      setReauthStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Re-authorization failed.',
      });
    }
  }

  async function handleRemove() {
    const confirmed = window.confirm(
      `Remove "${account.accountLabel || account.displayName || account.email}"? This will delete all local data for this account.`,
    );
    if (!confirmed) return;
    await deleteAccount(account.id);
    useAccountStore.getState().removeAccount(account.id);
    onUpdate();
  }

  const isOAuthImap = account.authMethod === 'oauth2' && account.oauthProvider;
  const statusMessageClass = statusColorClass(testStatus.type);
  const reauthMessageClass = statusColorClass(reauthStatus.type);

  return (
    <div className="space-y-5">
      <PreferencesSectionCard title="Identity" icon={PreferencesAccountsIcon}>
        <form onSubmit={handleSaveIdentity} className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted-text)]">Account label</span>
            <input
              type="text"
              value={accountLabel}
              onChange={(e) => setAccountLabel(e.target.value)}
              placeholder="Work Gmail"
              className="h-9 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted-text)]">Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your Name"
              className="h-9 px-3 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--muted-text)]">Email address</span>
            <span className="text-sm text-[var(--foreground)]">{account.email}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={isSavingIdentity}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isSavingIdentity ? 'Saving…' : 'Save identity'}
            </button>
          </div>
        </form>
      </PreferencesSectionCard>

      <PreferencesSectionCard title="Status & Default">
        <label className="flex items-center gap-3 py-2 cursor-pointer group rounded-md hover:bg-[color-mix(in_oklab,var(--surface),black_4%)] px-2 -mx-2 transition-colors">
          <input
            type="checkbox"
            checked={account.isActive}
            onChange={() => void handleToggleActive()}
            className="rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--ring)]"
          />
          <span className="text-sm text-[var(--foreground)]">Active (sync enabled)</span>
        </label>
        <button
          type="button"
          disabled={account.isDefault}
          onClick={() => void handleSetDefault()}
          className="mt-2 px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
        >
          {account.isDefault ? 'Default account' : 'Set as default account'}
        </button>
      </PreferencesSectionCard>

      <PreferencesSectionCard title="Server settings">
        <div className="flex items-center gap-2 mb-3">
          <ProviderBadge provider={account.provider} setupProviderId={account.setupProviderId} />
          {account.authMethod && (
            <span className="text-xs text-[var(--muted-text)]">Auth: {account.authMethod}</span>
          )}
        </div>

        {account.provider === 'imap' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <ReadOnlyField label="IMAP host" value={account.imapHost} />
              <ReadOnlyField label="IMAP port" value={account.imapPort} />
              <ReadOnlyField label="IMAP security" value={account.imapSecurity} />
              <ReadOnlyField label="SMTP host" value={account.smtpHost} />
              <ReadOnlyField label="SMTP port" value={account.smtpPort} />
              <ReadOnlyField label="SMTP security" value={account.smtpSecurity} />
            </div>
            <label className="flex items-center gap-3 py-2 cursor-pointer group rounded-md hover:bg-[color-mix(in_oklab,var(--surface),black_4%)] px-2 -mx-2 transition-colors mt-2">
              <input
                type="checkbox"
                checked={account.acceptInvalidCerts}
                onChange={async () => {
                  await updateAccount(account.id, {
                    acceptInvalidCerts: !account.acceptInvalidCerts,
                  });
                  onUpdate();
                }}
                className="rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--ring)]"
              />
              <span className="text-sm text-[var(--foreground)]">Accept invalid / self-signed certificates</span>
            </label>
          </>
        )}

        {account.provider === 'eas' && (
          <div className="grid grid-cols-2 gap-3">
            <ReadOnlyField label="EAS URL" value={account.easUrl} />
            <ReadOnlyField label="Protocol version" value={account.easProtocolVersion} />
            <ReadOnlyField label="Device ID" value={account.easDeviceId} />
          </div>
        )}
      </PreferencesSectionCard>

      <PreferencesSectionCard title="Actions">
        <div className="flex flex-wrap items-center gap-3">
          {isOAuthImap && (
            <button
              type="button"
              onClick={() => void handleReauthorize()}
              disabled={reauthStatus.type === 'loading'}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
            >
              {reauthStatus.type === 'loading' ? 'Re-authorizing…' : 'Re-authorize'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleTestConnection()}
            disabled={testStatus.type === 'loading'}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
          >
            {testStatus.type === 'loading' ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="button"
            onClick={() => void handleRemove()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-[color-mix(in_oklab,var(--destructive),transparent_80%)] bg-[color-mix(in_oklab,var(--destructive),transparent_92%)] text-[var(--destructive)] hover:bg-[color-mix(in_oklab,var(--destructive),transparent_88%)] transition-colors"
          >
            <TrashIcon size={14} />
            Remove account
          </button>
        </div>
        {reauthStatus.message && (
          <p className={`text-xs ${reauthMessageClass}`}>{reauthStatus.message}</p>
        )}
        {testStatus.message && (
          <p className={`text-xs ${statusMessageClass}`}>{testStatus.message}</p>
        )}
      </PreferencesSectionCard>

      <PreferencesSectionCard title="Send-as aliases">
        <AliasManager account={account} />
      </PreferencesSectionCard>
    </div>
  );
}
