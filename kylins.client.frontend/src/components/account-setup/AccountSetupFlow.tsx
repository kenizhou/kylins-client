import { useState } from 'react';
import { useAccountSetupStore } from '../../stores/accountSetupStore';
import { ProviderPicker } from './ProviderPicker';
import { CredentialsGate } from './CredentialsGate';
import { OAuthPendingScreen } from './OAuthPendingScreen';
import { ImapManualForm } from './ImapManualForm';
import { EasManualForm } from './EasManualForm';
import { VerifyStep } from './VerifyStep';
import { WelcomeScreen } from './WelcomeScreen';
import { SetupShell, SetupStepTransition } from './setup-ui';
import {
  runOAuthFlow,
  testImapConnection,
  testEasConnection,
  buildOAuthImapAccount,
  buildImapAccount,
  buildEasAccount,
  newDeviceId,
} from '../../services/auth/accountSetupFlows';
import { createAccount, getAllAccounts, type CreateAccountInput } from '../../services/accounts';
import { useAccountStore } from '../../stores/accountStore';
import type { Account } from '../../types';

export interface AccountSetupFlowProps {
  variant: 'fullscreen' | 'modal';
  onComplete: () => void;
}

/**
 * Temporary Account used only for the pre-save IMAP/EAS connectivity probe.
 * `testImapConnection`/`testEasConnection` require a full `Account`, but the
 * real row isn't created until the probe succeeds — so we synthesize a
 * throwaway id and zeroed timestamps. (Service-layer signature taking
 * `CreateAccountInput` directly is a future cleanup; see task-12 report.)
 */
function toTestAccount(input: CreateAccountInput, email: string): Account {
  return {
    ...input,
    email,
    id: 'tmp',
    isActive: true,
    isDefault: false,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * Runs a setup step under the standard verifying → welcome/error transition.
 * Sets `verifying` + clears any prior error before the async work, moves to
 * `welcome` on success, or captures the message and shows `error` on failure.
 */
async function runWithVerification(
  s: ReturnType<typeof useAccountSetupStore.getState>,
  work: () => Promise<void>,
): Promise<void> {
  s.setStep('verifying');
  s.setError(null);
  try {
    await work();
    s.setStep('welcome');
  } catch (e) {
    s.setError((e as Error).message);
    s.setStep('error');
  }
}

export function AccountSetupFlow({ variant, onComplete }: AccountSetupFlowProps) {
  const s = useAccountSetupStore();
  // Auth URL shown on the oauth-pending screen as a copyable fallback. Populated
  // from runOAuthFlow's onStarted callback right after the browser opens.
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string>('');
  // Stable fallback so we don't regenerate a device ID on every render.
  const [deviceIdFallback] = useState<string>(() => newDeviceId());

  async function handleOAuth(): Promise<void> {
    if (!s.config || s.config.authType !== 'oauth2') return;
    const config = s.config;
    // OAuth has its own transition sequence (oauth-pending -> verifying ->
    // welcome/error) because it must show a cancellable pending screen while
    // the user completes sign-in in their browser. runWithVerification skips
    // straight to `verifying`, which would render OAuthPendingScreen dead.
    s.setError(null);
    s.setStep('oauth-pending');
    setOauthAuthUrl('');
    try {
      const { tokens, userInfo } = await runOAuthFlow(config, {
        email: s.email,
        clientId: s.advancedClientId || undefined,
        clientSecret: s.advancedClientSecret || config.bundledClientSecret,
        onStarted: (authUrl) => setOauthAuthUrl(authUrl),
      });
      s.setStep('verifying');
      const input = buildOAuthImapAccount(
        config,
        userInfo,
        tokens,
        s.advancedClientId || config.bundledClientId,
      );
      await createAccount(input);
      s.setStep('welcome');
    } catch (e) {
      s.setError((e as Error).message);
      s.setStep('error');
    }
  }

  async function handleImapPassword(useManual: boolean): Promise<void> {
    if (!s.config || s.config.authType !== 'password') return;
    const config = s.config;
    await runWithVerification(s, async () => {
      const input = buildImapAccount(config, s.email, s.password);
      if (useManual) {
        input.imapHost = s.imapHost;
        input.imapPort = Number(s.imapPort) || 993;
        input.imapSecurity = s.imapSecurity;
        input.smtpHost = s.smtpHost;
        input.smtpPort = Number(s.smtpPort) || 587;
        input.smtpSecurity = s.smtpSecurity;
      }
      await testImapConnection(toTestAccount(input, s.email));
      await createAccount(input);
    });
  }

  async function handleEas(): Promise<void> {
    if (!s.config) return;
    const deviceId = s.deviceId || deviceIdFallback;
    // Derive the EAS server from the email domain unless the user overrode it.
    // Guard against an email with no `@` — under noUncheckedIndexedAccess
    // `split('@')[1]` is `string | undefined`, which would otherwise build
    // `https://undefined/Microsoft-Server-ActiveSync`.
    let server = s.easServer;
    if (!server) {
      const domain = s.email.split('@')[1];
      if (!domain) {
        s.setError('Enter a valid email address');
        s.setStep('error');
        return;
      }
      server = `https://${domain}/Microsoft-Server-ActiveSync`;
    }
    await runWithVerification(s, async () => {
      const input = buildEasAccount(s.email, s.password, server, deviceId, s.config!.id);
      await testEasConnection(toTestAccount(input, s.email));
      await createAccount(input);
    });
  }

  function onSignIn(): void {
    if (!s.config) return;
    if (s.config.authType === 'oauth2') void handleOAuth();
    else if (s.config.id === 'exchange') void handleEas();
    else void handleImapPassword(false);
  }

  function onManualSetup(): void {
    if (!s.config) return;
    s.setStep(s.config.id === 'exchange' ? 'eas-manual' : 'imap-manual');
  }

  return (
    <SetupShell variant={variant}>
      {s.step === 'pick' && (
        <SetupStepTransition>
          <ProviderPicker onPick={(id) => s.selectProvider(id)} />
        </SetupStepTransition>
      )}

      {s.step === 'gateway' && s.config && (
        <SetupStepTransition>
          <CredentialsGate
            config={s.config}
            email={s.email}
            password={s.password}
            advancedClientId={s.advancedClientId}
            advancedClientSecret={s.advancedClientSecret}
            onChange={(patch) => {
              if (patch.email !== undefined) s.setEmail(patch.email);
              if (patch.password !== undefined) s.setPassword(patch.password);
              if (patch.advancedClientId !== undefined)
                s.setAdvancedClientId(patch.advancedClientId);
              if (patch.advancedClientSecret !== undefined)
                s.setAdvancedClientSecret(patch.advancedClientSecret);
            }}
            onSignIn={onSignIn}
            onManualSetup={onManualSetup}
            onBack={s.back}
            canSubmit={s.canSubmit()}
          />
        </SetupStepTransition>
      )}

      {s.step === 'oauth-pending' && s.config && (
        <SetupStepTransition>
          <OAuthPendingScreen
            providerName={s.config.name}
            fallbackUrl={oauthAuthUrl}
            onCancel={s.back}
          />
        </SetupStepTransition>
      )}

      {s.step === 'imap-manual' && (
        <SetupStepTransition>
          <ImapManualForm
            values={{
              imapHost: s.imapHost,
              imapPort: s.imapPort,
              imapSecurity: s.imapSecurity,
              smtpHost: s.smtpHost,
              smtpPort: s.smtpPort,
              smtpSecurity: s.smtpSecurity,
            }}
            onChange={(patch) => {
              if (patch.imapHost !== undefined) s.setImap({ imapHost: patch.imapHost });
              if (patch.imapPort !== undefined) s.setImap({ imapPort: patch.imapPort });
              if (patch.imapSecurity !== undefined) s.setImap({ imapSecurity: patch.imapSecurity });
              if (patch.smtpHost !== undefined) s.setSmtp({ smtpHost: patch.smtpHost });
              if (patch.smtpPort !== undefined) s.setSmtp({ smtpPort: patch.smtpPort });
              if (patch.smtpSecurity !== undefined) s.setSmtp({ smtpSecurity: patch.smtpSecurity });
            }}
            onSubmit={() => void handleImapPassword(true)}
            onBack={s.back}
            canSubmit={!!s.imapHost && !!s.smtpHost}
          />
        </SetupStepTransition>
      )}

      {s.step === 'eas-manual' && (
        <SetupStepTransition>
          <EasManualForm
            server={s.easServer}
            deviceId={s.deviceId || deviceIdFallback}
            onChange={(patch) => {
              if (patch.server !== undefined) s.setEasServer(patch.server);
              if (patch.deviceId !== undefined) s.setDeviceId(patch.deviceId);
            }}
            onSubmit={() => void handleEas()}
            onBack={s.back}
            canSubmit={!!s.easServer}
          />
        </SetupStepTransition>
      )}

      {(s.step === 'verifying' || s.step === 'error') && (
        <SetupStepTransition>
          <VerifyStep
            error={s.step === 'error' ? s.error : null}
            onRetry={() => s.setStep('gateway')}
            onBack={s.back}
          />
        </SetupStepTransition>
      )}

      {s.step === 'welcome' && (
        <SetupStepTransition>
          <WelcomeScreen
            onDone={async () => {
              const refreshed = await getAllAccounts();
              useAccountStore.getState().setAccounts(refreshed);
              s.reset();
              onComplete();
            }}
          />
        </SetupStepTransition>
      )}
    </SetupShell>
  );
}
