import { useAccountSetupStore } from '../../stores/accountSetupStore';
import { ProviderPicker } from './ProviderPicker';
import { CredentialsGate } from './CredentialsGate';
import { OAuthPendingScreen } from './OAuthPendingScreen';
import { ImapManualForm } from './ImapManualForm';
import { EasManualForm } from './EasManualForm';
import { VerifyStep } from './VerifyStep';
import { WelcomeScreen } from './WelcomeScreen';
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

const shellClass = (variant: 'fullscreen' | 'modal') =>
  variant === 'fullscreen'
    ? 'flex h-screen w-screen items-center justify-center bg-[var(--background)] p-8'
    : 'flex h-full w-full items-center justify-center bg-[var(--background)] p-8';

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

  async function handleOAuth(): Promise<void> {
    if (!s.config || s.config.authType !== 'oauth2') return;
    const config = s.config;
    await runWithVerification(s, async () => {
      const { tokens, userInfo } = await runOAuthFlow(config, {
        email: s.email,
        clientId: s.advancedClientId || undefined,
        clientSecret: s.advancedClientSecret || undefined,
      });
      const input = buildOAuthImapAccount(
        config,
        userInfo,
        tokens,
        s.advancedClientId || config.bundledClientId,
      );
      await createAccount(input);
    });
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
    const deviceId = s.deviceId || newDeviceId();
    const server = s.easServer || `https://${s.email.split('@')[1]}/Microsoft-Server-ActiveSync`;
    await runWithVerification(s, async () => {
      const input = buildEasAccount(s.email, s.password, server, deviceId);
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
    <div className={shellClass(variant)}>
      {s.step === 'pick' && <ProviderPicker onPick={(id) => s.selectProvider(id)} />}

      {s.step === 'gateway' && s.config && (
        <CredentialsGate
          config={s.config}
          email={s.email}
          password={s.password}
          advancedClientId={s.advancedClientId}
          advancedClientSecret={s.advancedClientSecret}
          onChange={(patch) => {
            if (patch.email !== undefined) s.setEmail(patch.email);
            if (patch.password !== undefined) s.setPassword(patch.password);
            if (patch.advancedClientId !== undefined) s.setAdvancedClientId(patch.advancedClientId);
            if (patch.advancedClientSecret !== undefined)
              s.setAdvancedClientSecret(patch.advancedClientSecret);
          }}
          onSignIn={onSignIn}
          onManualSetup={onManualSetup}
          canSubmit={s.canSubmit()}
        />
      )}

      {s.step === 'oauth-pending' && s.config && (
        <OAuthPendingScreen
          providerName={s.config.name}
          fallbackUrl={`http://127.0.0.1:17249?state=…`}
          onCancel={() => s.setStep('gateway')}
        />
      )}

      {s.step === 'imap-manual' && (
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
          canSubmit={!!s.imapHost && !!s.smtpHost}
        />
      )}

      {s.step === 'eas-manual' && (
        <EasManualForm
          server={s.easServer}
          deviceId={s.deviceId || newDeviceId()}
          onChange={(patch) => {
            if (patch.server !== undefined) s.setEasServer(patch.server);
            if (patch.deviceId !== undefined) s.setDeviceId(patch.deviceId);
          }}
          onSubmit={() => void handleEas()}
          canSubmit={!!s.easServer}
        />
      )}

      {(s.step === 'verifying' || s.step === 'error') && (
        <VerifyStep
          error={s.step === 'error' ? s.error : null}
          onRetry={() => s.setStep('gateway')}
          onBack={() => s.setStep('gateway')}
        />
      )}

      {s.step === 'welcome' && (
        <WelcomeScreen
          onDone={async () => {
            const refreshed = await getAllAccounts();
            useAccountStore.getState().setAccounts(refreshed);
            s.reset();
            onComplete();
          }}
        />
      )}
    </div>
  );
}
