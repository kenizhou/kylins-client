import { openUrl } from '@tauri-apps/plugin-opener';
import type { Account } from '../../types';
import type { CreateAccountInput } from '../accounts';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  startOAuthServer,
  exchangeToken,
} from './oauth';
import type { OAuthProviderConfig, PasswordProviderConfig } from './providers';
import { presetsFor, buildAuthUrl, getProvider } from './providers';
import { fetchUserInfo, type ProviderUserInfo } from './userInfo';
import { updateAccount } from '../accounts';
import { ImapProvider } from '../mail/imapProvider';
import { EasProvider } from '../mail/easProvider';
import { testConnection as smtpTestConnection } from '../mail/smtpSender';
import type { TokenExchangeResult } from '../../types';

export async function openExternalUrl(url: string): Promise<void> {
  await openUrl(url);
}

export function newDeviceId(): string {
  return 'KYLINS-' + crypto.randomUUID().toUpperCase().slice(0, 12);
}

export async function runOAuthFlow(
  config: OAuthProviderConfig,
  opts: {
    email: string;
    clientId?: string;
    clientSecret?: string;
    /** Invoked after the browser is opened with the auth URL the user should visit. */
    onStarted?: (authUrl: string) => void;
  },
): Promise<{ tokens: TokenExchangeResult; userInfo: ProviderUserInfo }> {
  const clientId = opts.clientId || config.bundledClientId;
  if (!clientId) {
    throw new Error(
      'No OAuth client_id configured. Enter one under Advanced, or register a bundled client_id in providers.ts.',
    );
  }
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();
  const redirectUri = config.redirectUri;
  const authUrl = buildAuthUrl(config, {
    clientId,
    redirectUri,
    codeChallenge: challenge,
    state,
    email: opts.email,
  });

  // Open the browser BEFORE binding the loopback listener. If the opener throws
  // we leak no port (previously a retry would cascade 17249 -> 17250 -> ...).
  // The sub-millisecond race (redirect arriving before the TCP bind) is
  // negligible because a human cannot complete OAuth consent that fast.
  await openExternalUrl(authUrl);
  opts.onStarted?.(authUrl);
  const { code } = await startOAuthServer(config.callbackPort, state);

  const tokens = await exchangeToken({
    tokenUrl: config.tokenUrl,
    code,
    clientId,
    redirectUri,
    codeVerifier: verifier,
    clientSecret: opts.clientSecret || config.bundledClientSecret,
    scope: config.scopes.join(' '),
  });

  // fetchUserInfo degrades gracefully on any failure (missing/malformed
  // id_token, userinfo endpoint down) and falls back to the typed email.
  const userInfo = await fetchUserInfo(config, tokens, opts.email);
  return { tokens, userInfo };
}

export async function testImapConnection(account: Account): Promise<void> {
  const imap = new ImapProvider(account);
  await imap.connect(); // throws on failure
  await smtpTestConnection(account);
}

export async function testEasConnection(account: Account): Promise<void> {
  const eas = new EasProvider(account);
  await eas.connect(); // FolderSync with syncKey 0 — throws on failure
}

export function buildOAuthImapAccount(
  config: OAuthProviderConfig,
  userInfo: ProviderUserInfo,
  tokens: TokenExchangeResult,
  clientId: string,
): CreateAccountInput {
  const p = config.presets;
  const tokenExpiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600);
  return {
    email: userInfo.email,
    displayName: userInfo.displayName,
    provider: 'imap',
    setupProviderId: config.id,
    authMethod: 'oauth2',
    oauthProvider: config.oauthProvider,
    oauthClientId: clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? undefined,
    tokenExpiresAt,
    imapHost: p.imapHost,
    imapPort: p.imapPort,
    imapSecurity: p.imapSecurity,
    smtpHost: p.smtpHost,
    smtpPort: p.smtpPort,
    smtpSecurity: p.smtpSecurity,
    imapUsername: userInfo.email,
  };
}

export function buildImapAccount(
  config: PasswordProviderConfig,
  email: string,
  password: string,
): CreateAccountInput {
  const p = presetsFor(config);
  return {
    email,
    provider: 'imap',
    setupProviderId: config.id,
    authMethod: 'password',
    imapPassword: password,
    imapUsername: email,
    imapHost: p?.imapHost,
    imapPort: p?.imapPort,
    imapSecurity: p?.imapSecurity,
    smtpHost: p?.smtpHost,
    smtpPort: p?.smtpPort,
    smtpSecurity: p?.smtpSecurity,
  };
}

export function buildEasAccount(
  email: string,
  password: string,
  serverUrl: string,
  deviceId: string,
  configId: string,
): CreateAccountInput {
  return {
    email,
    provider: 'eas',
    setupProviderId: configId,
    imapUsername: email,
    imapPassword: password,
    easUrl: serverUrl,
    easProtocolVersion: '16.1',
    easDeviceId: deviceId,
  };
}

function oauthConfigForAccount(account: Account): OAuthProviderConfig | null {
  const setupId = account.setupProviderId;
  if (setupId === 'gmail' || setupId === 'outlook' || setupId === 'microsoft365') {
    const cfg = getProvider(setupId);
    if (cfg.authType === 'oauth2') return cfg;
  }
  if (account.oauthProvider === 'google') {
    const cfg = getProvider('gmail');
    return cfg.authType === 'oauth2' ? cfg : null;
  }
  if (account.oauthProvider === 'microsoft') {
    const cfg = getProvider('outlook');
    return cfg.authType === 'oauth2' ? cfg : null;
  }
  return null;
}

export async function reauthorizeAccount(
  account: Account,
  opts?: {
    clientId?: string;
    clientSecret?: string;
    onStarted?: (authUrl: string) => void;
  },
): Promise<void> {
  const config = oauthConfigForAccount(account);
  if (!config) {
    throw new Error('This account does not support re-authorization');
  }

  const { tokens, userInfo } = await runOAuthFlow(config, {
    email: account.email,
    clientId: opts?.clientId,
    clientSecret: opts?.clientSecret,
    onStarted: opts?.onStarted,
  });

  const tokenExpiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600);

  await updateAccount(account.id, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? undefined,
    tokenExpiresAt,
    displayName: userInfo.displayName,
    // Keep the same provider/presets; only tokens and identity may refresh.
  });
}
