import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAccountSetupStore } from '../../stores/accountSetupStore';
import {
  getCredentialsGateErrors,
  getImapManualErrors,
  getEasManualErrors,
  type ImapManualFormErrors,
  type EasManualFormErrors,
  type CredentialsGateErrors,
} from '../../stores/accountSetupStore';
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
import {
  createAccount,
  getAllAccounts,
  deleteAccountByEmail,
  type CreateAccountInput,
} from '../../services/accounts';
import { useAccountStore } from '../../stores/accountStore';
import type { Account } from '../../types';

export interface AccountSetupFlowProps {
  variant: 'fullscreen' | 'modal';
  onComplete: () => void;
}

const STEP_ANNOUNCEMENTS: Record<ReturnType<typeof useAccountSetupStore.getState>['step'], string> =
  {
    pick: 'Choose your email provider.',
    gateway: 'Add your account.',
    'oauth-pending': 'Sign in with your browser.',
    'imap-manual': 'Enter server settings.',
    'eas-manual': 'Enter Exchange server settings.',
    verifying: 'Connecting your account.',
    welcome: 'Account connected.',
    error: 'Could not connect.',
  };

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
    const message = e instanceof Error ? e.message : String(e);
    s.setError(message);
    s.setStep('error');
  }
}

function useStepAnnouncement(step: string, error: string | null): string {
  const base = STEP_ANNOUNCEMENTS[step as keyof typeof STEP_ANNOUNCEMENTS] ?? '';
  return step === 'error' && error ? `Could not connect: ${error}` : base;
}

export function AccountSetupFlow({ variant, onComplete }: AccountSetupFlowProps) {
  const s = useAccountSetupStore();
  const contentRef = useRef<HTMLElement>(null);
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string>('');
  const [deviceIdFallback] = useState<string>(() => newDeviceId());
  const [testState, setTestState] = useState<{
    isTesting: boolean;
    result: { success: boolean; message: string } | null;
  }>({ isTesting: false, result: null });
  const [showCredentialsErrors, setShowCredentialsErrors] = useState(false);
  const [showImapErrors, setShowImapErrors] = useState(false);
  const [showEasErrors, setShowEasErrors] = useState(false);

  const announcement = useStepAnnouncement(s.step, s.error);

  useEffect(() => {
    const heading = contentRef.current?.querySelector<HTMLElement>('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [s.step]);

  async function handleOAuth(): Promise<void> {
    if (!s.config || s.config.authType !== 'oauth2') return;
    const config = s.config;
    setShowCredentialsErrors(true);
    const fieldErrors = getCredentialsGateErrors(s);
    if (Object.keys(fieldErrors).length > 0) return;

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

    if (useManual) {
      setShowImapErrors(true);
      const fieldErrors = getImapManualErrors(s);
      if (Object.keys(fieldErrors).length > 0) return;
    } else {
      setShowCredentialsErrors(true);
      const fieldErrors = getCredentialsGateErrors(s);
      if (Object.keys(fieldErrors).length > 0) return;
    }

    await runWithVerification(s, async () => {
      const input = buildImapAccount(config, s.email, s.password);
      input.acceptInvalidCerts = s.acceptInvalidCerts;
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

  async function handleTestConnection(): Promise<void> {
    if (!s.config || s.config.authType !== 'password') return;
    setShowImapErrors(true);
    const fieldErrors = getImapManualErrors(s);
    if (Object.keys(fieldErrors).length > 0) {
      setTestState({
        isTesting: false,
        result: { success: false, message: 'Fill in all server fields first.' },
      });
      return;
    }
    setTestState({ isTesting: true, result: null });
    try {
      const input = buildImapAccount(s.config, s.email, s.password);
      input.acceptInvalidCerts = s.acceptInvalidCerts;
      input.imapHost = s.imapHost;
      input.imapPort = Number(s.imapPort) || 993;
      input.imapSecurity = s.imapSecurity;
      input.smtpHost = s.smtpHost;
      input.smtpPort = Number(s.smtpPort) || 587;
      input.smtpSecurity = s.smtpSecurity;
      await testImapConnection(toTestAccount(input, s.email));
      setTestState({
        isTesting: false,
        result: { success: true, message: 'IMAP and SMTP connections verified.' },
      });
    } catch (e) {
      setTestState({ isTesting: false, result: { success: false, message: (e as Error).message } });
    }
  }

  async function handleEas(): Promise<void> {
    if (!s.config) return;
    setShowEasErrors(true);
    const fieldErrors = getEasManualErrors(s);
    if (Object.keys(fieldErrors).length > 0) return;

    const deviceId = s.deviceId || deviceIdFallback;
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

  async function handleReplace(): Promise<void> {
    try {
      await deleteAccountByEmail(s.email);
      s.setStep('gateway');
    } catch (e) {
      s.setError(e instanceof Error ? e.message : String(e));
    }
  }

  const credentialsErrors: CredentialsGateErrors = showCredentialsErrors
    ? getCredentialsGateErrors(s)
    : {};
  const imapErrors: ImapManualFormErrors = showImapErrors ? getImapManualErrors(s) : {};
  const easErrors: EasManualFormErrors = showEasErrors ? getEasManualErrors(s) : {};

  return (
    <SetupShell variant={variant} announcement={announcement} contentRef={contentRef}>
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
            errors={credentialsErrors}
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
              acceptInvalidCerts: s.acceptInvalidCerts,
            }}
            errors={imapErrors}
            onChange={(patch) => {
              if (patch.imapHost !== undefined) s.setImap({ imapHost: patch.imapHost });
              if (patch.imapPort !== undefined) s.setImap({ imapPort: patch.imapPort });
              if (patch.imapSecurity !== undefined) s.setImap({ imapSecurity: patch.imapSecurity });
              if (patch.smtpHost !== undefined) s.setSmtp({ smtpHost: patch.smtpHost });
              if (patch.smtpPort !== undefined) s.setSmtp({ smtpPort: patch.smtpPort });
              if (patch.smtpSecurity !== undefined) s.setSmtp({ smtpSecurity: patch.smtpSecurity });
              if (patch.acceptInvalidCerts !== undefined)
                s.setAcceptInvalidCerts(patch.acceptInvalidCerts);
            }}
            onSubmit={() => void handleImapPassword(true)}
            onTestConnection={() => void handleTestConnection()}
            onBack={s.back}
            canSubmit={!!s.imapHost && !!s.smtpHost}
            isTesting={testState.isTesting}
            testResult={testState.result}
          />
        </SetupStepTransition>
      )}

      {s.step === 'eas-manual' && (
        <SetupStepTransition>
          <EasManualForm
            server={s.easServer}
            deviceId={s.deviceId || deviceIdFallback}
            errors={easErrors}
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
            onReplace={() => void handleReplace()}
          />
        </SetupStepTransition>
      )}

      {s.step === 'welcome' && (
        <SetupStepTransition>
          <WelcomeScreen
            onDone={async () => {
              const refreshed = await getAllAccounts();
              useAccountStore.getState().setAccounts(refreshed);
              const created = refreshed.find((a) => a.email === s.email);
              if (created) {
                invoke('sync_account_now', { accountId: created.id }).catch((err) =>
                  console.error('sync_account_now failed:', err),
                );
              }
              s.reset();
              onComplete();
            }}
          />
        </SetupStepTransition>
      )}
    </SetupShell>
  );
}
