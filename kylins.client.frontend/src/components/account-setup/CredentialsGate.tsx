import { Button } from 'react-aria-components';
import { useId, useState } from 'react';
import { PopOutIcon } from '../icons';
import type { ProviderConfig } from '../../services/auth/providers';
import {
  SetupCard,
  SetupHeader,
  SetupButton,
  SetupInput,
  SetupBackButton,
  SetupField,
} from './setup-ui';

export interface CredentialsGateErrors {
  email?: string;
  password?: string;
}

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
  errors?: CredentialsGateErrors;
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
  errors = {},
}: CredentialsGateProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advancedPanelId = useId();
  const isOAuth = config.authType === 'oauth2';

  const appPasswordHint = config.authType === 'password' && config.appPasswordNote && (
    <>
      {config.appPasswordNote}{' '}
      {config.appPasswordUrl && (
        <a
          className="inline-flex items-center gap-0.5 rounded underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          href={config.appPasswordUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Create one
          <PopOutIcon size={12} aria-hidden="true" />
        </a>
      )}
    </>
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSignIn();
  }

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
        hideMark
      />

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <SetupField label="Email address" hint={appPasswordHint || undefined} error={errors.email}>
          <SetupInput
            type="email"
            placeholder="your.email@example.com"
            value={email}
            onChange={(e) => onChange({ email: e.target.value })}
            autoComplete="email"
            spellCheck={false}
            autoFocus
          />
        </SetupField>

        {!isOAuth && (
          <SetupField label="Password" error={errors.password}>
            <SetupInput
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => onChange({ password: e.target.value })}
              autoComplete="current-password"
            />
          </SetupField>
        )}

        {isOAuth && (
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              className="setup-focus-ring min-h-11 self-start px-2 text-xs font-medium text-muted-text underline transition-colors hover:text-foreground"
              onPress={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              aria-controls={advancedPanelId}
            >
              {showAdvanced ? 'Hide' : 'Show'} advanced OAuth credentials
            </Button>

            {showAdvanced && (
              <div
                id={advancedPanelId}
                className="flex flex-col gap-3 rounded-lg border border-border bg-secondary p-3"
              >
                <SetupField label="Client ID (optional override)">
                  <SetupInput
                    placeholder="Client ID"
                    value={advancedClientId}
                    onChange={(e) => onChange({ advancedClientId: e.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </SetupField>
                <SetupField label="Client secret (optional)">
                  <SetupInput
                    type="password"
                    placeholder="Client secret"
                    value={advancedClientSecret}
                    onChange={(e) => onChange({ advancedClientSecret: e.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </SetupField>
              </div>
            )}
          </div>
        )}

        <div className="mt-8 flex items-center justify-between">
          <SetupBackButton onPress={onBack} />
          <div className="flex items-center gap-2">
            {config.authType === 'password' && !config.presets && (
              <SetupButton variant="secondary" type="button" onPress={onManualSetup}>
                Manual setup
              </SetupButton>
            )}
            <SetupButton type="submit" disabled={!canSubmit}>
              {isOAuth ? 'Continue with provider' : 'Sign in'}
            </SetupButton>
          </div>
        </div>
      </form>
    </SetupCard>
  );
}
