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
  displayName?: string;
  email?: string;
  password?: string;
}

export interface CredentialsGateProps {
  config: ProviderConfig;
  displayName: string;
  email: string;
  password: string;
  advancedClientId: string;
  advancedClientSecret: string;
  onChange: (
    patch: Partial<{
      displayName: string;
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
  displayName,
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
  const isImap = config.id === 'imap';

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

  const title = isImap ? 'Add your IMAP account' : `Add your ${config.name} account`;

  return (
    <SetupCard width="lg">
      <SetupHeader
        title={title}
        hideMark
        subtitle={
          isOAuth
            ? 'Sign in securely through your provider’s website.'
            : 'Enter your account credentials to get started. Kylins stores your password securely and never sends it to our servers.'
        }
      />

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <SetupField label="Name" error={errors.displayName}>
          <SetupInput
            type="text"
            placeholder="Your name"
            value={displayName}
            onChange={(e) => onChange({ displayName: e.target.value })}
            autoComplete="name"
            spellCheck={false}
            autoFocus
          />
        </SetupField>

        <SetupField label="Email address" hint={appPasswordHint || undefined} error={errors.email}>
          <SetupInput
            type="email"
            placeholder="your.email@example.com"
            value={email}
            onChange={(e) => onChange({ email: e.target.value })}
            autoComplete="email"
            spellCheck={false}
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
          <div className="flex flex-col gap-3 pt-1">
            <Button
              type="button"
              className="setup-focus-ring min-h-11 self-center px-2 text-xs font-medium text-muted-text underline transition-colors hover:text-foreground"
              onPress={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              aria-controls={advancedPanelId}
            >
              {showAdvanced ? 'Hide' : 'Show'} advanced OAuth credentials
            </Button>

            {showAdvanced && (
              <div
                id={advancedPanelId}
                className="flex flex-col gap-3 rounded-lg border border-border/60 bg-secondary/70 p-3"
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

        <div className="mt-6 flex items-center justify-between">
          <SetupBackButton onPress={onBack} />
          <div className="flex items-center gap-3">
            {config.authType === 'password' && !config.presets && (
              <SetupButton variant="secondary" type="button" onPress={onManualSetup}>
                Manual setup
              </SetupButton>
            )}
            <SetupButton type="submit" disabled={!canSubmit}>
              {isOAuth ? 'Continue with provider' : 'Continue'}
            </SetupButton>
          </div>
        </div>
      </form>
    </SetupCard>
  );
}
