import { useState } from 'react';
import type { ProviderConfig } from '../../services/auth/providers';

export interface CredentialsGateProps {
  config: ProviderConfig;
  email: string;
  password: string;
  advancedClientId: string;
  advancedClientSecret: string;
  onChange: (
    patch: Partial<{
      email: string;
      password: string;
      advancedClientId: string;
      advancedClientSecret: string;
    }>,
  ) => void;
  onSignIn: () => void;
  onManualSetup: () => void;
  canSubmit: boolean;
}

const inputClass =
  'w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]';

export function CredentialsGate({
  config,
  email,
  password,
  advancedClientId,
  advancedClientSecret,
  onChange,
  onSignIn,
  onManualSetup,
  canSubmit,
}: CredentialsGateProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isOAuth = config.authType === 'oauth2';

  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">
        Add your {config.name} account
      </h1>

      <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
        Email
        <input
          className={inputClass}
          placeholder="your.email@example.com"
          value={email}
          onChange={(e) => onChange({ email: e.target.value })}
        />
      </label>

      {!isOAuth && (
        <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
          Password
          <input
            type="password"
            className={inputClass}
            value={password}
            onChange={(e) => onChange({ password: e.target.value })}
          />
        </label>
      )}

      {config.authType === 'password' && config.appPasswordNote && (
        <p className="text-xs text-[var(--muted-text)]">
          {config.appPasswordNote}{' '}
          {config.appPasswordUrl && (
            <a className="underline" href={config.appPasswordUrl} target="_blank" rel="noreferrer">
              Create one
            </a>
          )}
        </p>
      )}

      {isOAuth && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className="self-start text-xs text-[var(--muted-text)] underline"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? 'Hide' : 'Advanced'} (OAuth client credentials)
          </button>
          {showAdvanced && (
            <div className="flex flex-col gap-2 rounded border border-[var(--border)] p-3">
              <input
                className={inputClass}
                placeholder="Client ID (optional override)"
                value={advancedClientId}
                onChange={(e) => onChange({ advancedClientId: e.target.value })}
              />
              <input
                className={inputClass}
                placeholder="Client secret (optional)"
                value={advancedClientSecret}
                onChange={(e) => onChange({ advancedClientSecret: e.target.value })}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          type="button"
          className="text-sm text-[var(--muted-text)] underline"
          onClick={onManualSetup}
        >
          Manual setup
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSignIn}
          className="rounded bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-40"
        >
          Sign in
        </button>
      </div>
    </div>
  );
}
