import { Button } from 'react-aria-components';
import { useState } from 'react';
import type { ProviderConfig } from '../../services/auth/providers';
import {
  SetupCard,
  SetupHeader,
  SetupButton,
  SetupInput,
  SetupBackButton,
  SetupField,
} from './setup-ui';

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
  onBack: () => void;
  canSubmit: boolean;
}

export function CredentialsGate({
  config,
  email,
  password,
  advancedClientId,
  advancedClientSecret,
  onChange,
  onSignIn,
  onManualSetup,
  onBack,
  canSubmit,
}: CredentialsGateProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isOAuth = config.authType === 'oauth2';

  const appPasswordHint = config.authType === 'password' && config.appPasswordNote && (
    <>
      {config.appPasswordNote}{' '}
      {config.appPasswordUrl && (
        <a
          className="underline hover:text-[var(--foreground)]"
          href={config.appPasswordUrl}
          target="_blank"
          rel="noreferrer"
        >
          Create one
        </a>
      )}
    </>
  );

  return (
    <SetupCard>
      <SetupHeader
        eyebrow={config.name}
        title="Add your account"
        subtitle={
          isOAuth
            ? 'Sign in securely through your provider’s website.'
            : 'Enter your email address and password to connect.'
        }
        align="left"
      />

      <div className="flex flex-col gap-4">
        <SetupField label="Email address" hint={appPasswordHint || undefined}>
          <SetupInput
            type="email"
            placeholder="your.email@example.com"
            value={email}
            onChange={(e) => onChange({ email: e.target.value })}
            autoFocus
          />
        </SetupField>

        {!isOAuth && (
          <SetupField label="Password">
            <SetupInput
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => onChange({ password: e.target.value })}
            />
          </SetupField>
        )}

        {isOAuth && (
          <div className="flex flex-col gap-3">
            <Button
              className="self-start text-xs font-medium text-[var(--muted-text)] underline transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--series-accent)]"
              onPress={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? 'Hide' : 'Show'} advanced OAuth credentials
            </Button>

            {showAdvanced && (
              <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-3">
                <SetupField label="Client ID (optional override)">
                  <SetupInput
                    placeholder="Client ID"
                    value={advancedClientId}
                    onChange={(e) => onChange({ advancedClientId: e.target.value })}
                  />
                </SetupField>
                <SetupField label="Client secret (optional)">
                  <SetupInput
                    type="password"
                    placeholder="Client secret"
                    value={advancedClientSecret}
                    onChange={(e) => onChange({ advancedClientSecret: e.target.value })}
                  />
                </SetupField>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <SetupBackButton onPress={onBack} />
        <div className="flex items-center gap-2">
          {config.authType === 'password' && !config.presets && (
            <SetupButton variant="secondary" onPress={onManualSetup}>
              Manual setup
            </SetupButton>
          )}
          <SetupButton onPress={onSignIn} disabled={!canSubmit}>
            {isOAuth ? 'Continue with provider' : 'Sign in'}
          </SetupButton>
        </div>
      </div>
    </SetupCard>
  );
}
