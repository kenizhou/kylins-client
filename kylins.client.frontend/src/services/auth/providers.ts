import type { SecurityMode } from '../../types';

export type SetupProviderId = 'gmail' | 'outlook' | 'microsoft365' | 'yahoo' | 'imap' | 'exchange';

export interface ProviderPresets {
  imapHost: string;
  imapPort: number;
  imapSecurity: SecurityMode;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SecurityMode;
}

export interface OAuthProviderConfig {
  id: SetupProviderId;
  name: string;
  authType: 'oauth2';
  oauthProvider: 'google' | 'microsoft';
  /** Bundled public client_id. Empty until registered with the provider; user can supply via Advanced. */
  bundledClientId: string;
  /** Optional bundled secret (confidential client). Public clients leave this undefined. */
  bundledClientSecret?: string;
  /** Redirect URI registered with the provider (loopback for desktop). */
  redirectUri: string;
  /** Local port the OAuth callback server binds; must match redirectUri. */
  callbackPort: number;
  authUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  scopes: string[];
  extraAuthParams: Record<string, string>;
  presets: ProviderPresets;
}

export interface PasswordProviderConfig {
  id: SetupProviderId;
  name: string;
  authType: 'password';
  presets?: ProviderPresets;
  /** Optional app-password guidance (Yahoo). */
  appPasswordNote?: string;
  appPasswordUrl?: string;
}

export type ProviderConfig = OAuthProviderConfig | PasswordProviderConfig;

export const OAUTH_CALLBACK_PORT = 17249;

const gmailPresets: ProviderPresets = {
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapSecurity: 'tls',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  smtpSecurity: 'starttls',
};
const microsoftPresets: ProviderPresets = {
  imapHost: 'outlook.office365.com',
  imapPort: 993,
  imapSecurity: 'tls',
  smtpHost: 'smtp.office365.com',
  smtpPort: 587,
  smtpSecurity: 'starttls',
};
const yahooPresets: ProviderPresets = {
  imapHost: 'imap.mail.yahoo.com',
  imapPort: 993,
  imapSecurity: 'tls',
  smtpHost: 'smtp.mail.yahoo.com',
  smtpPort: 465,
  smtpSecurity: 'tls',
};

export const PROVIDERS: Record<SetupProviderId, ProviderConfig> = {
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    authType: 'oauth2',
    oauthProvider: 'google',
    // Confidential-client credentials ported from mailkit_arkts so Gmail works
    // out-of-the-box for development. The secret is extractable from source —
    // replace with your own registered public client before any public release.
    bundledClientId: '',
    bundledClientSecret: '',
    redirectUri: 'http://localhost:5283/WeatherForecast',
    callbackPort: 5283,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.modify',
      'openid',
      'email',
      'profile',
    ],
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    presets: gmailPresets,
  },
  outlook: {
    id: 'outlook',
    name: 'Outlook',
    authType: 'oauth2',
    oauthProvider: 'microsoft',
    // Ported from mailkit_arkts (Azure app 87b9841a-...). NOTE: that app only
    // registers the `nativeclient` redirect, which kylins's loopback server
    // cannot capture — add `http://localhost:17249` to the app's Redirect URIs
    // in Azure before Outlook sign-in will complete.
    bundledClientId: '87b9841a-f9b8-45bc-83ce-18bf5f0705c3',
    redirectUri: `http://localhost:${OAUTH_CALLBACK_PORT}`,
    callbackPort: OAUTH_CALLBACK_PORT,
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
      'openid',
      'profile',
      'email',
    ],
    extraAuthParams: {},
    presets: microsoftPresets,
  },
  microsoft365: {
    id: 'microsoft365',
    name: 'Microsoft 365',
    authType: 'oauth2',
    oauthProvider: 'microsoft',
    // Ported from mailkit_arkts (same Azure app as Outlook, with secret).
    // Same redirect caveat: add `http://localhost:17249` to the app's URIs.
    bundledClientId: '87b9841a-f9b8-45bc-83ce-18bf5f0705c3',
    bundledClientSecret: '',
    redirectUri: `http://localhost:${OAUTH_CALLBACK_PORT}`,
    callbackPort: OAUTH_CALLBACK_PORT,
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
      'openid',
      'profile',
      'email',
    ],
    extraAuthParams: {},
    presets: microsoftPresets,
  },
  yahoo: {
    id: 'yahoo',
    name: 'Yahoo',
    authType: 'password',
    presets: yahooPresets,
    appPasswordNote: 'Yahoo requires an app password for mail apps.',
    appPasswordUrl: 'https://help.yahoo.com/kb/SLN15241.html',
  },
  imap: { id: 'imap', name: 'Other (IMAP/SMTP)', authType: 'password' },
  exchange: { id: 'exchange', name: 'Exchange (ActiveSync)', authType: 'password' },
};

export function getProvider(id: SetupProviderId): ProviderConfig {
  const cfg = PROVIDERS[id];
  if (!cfg) throw new Error(`Unknown provider: ${id}`);
  return cfg;
}

export function presetsFor(config: ProviderConfig): ProviderPresets | undefined {
  return config.authType === 'password' ? config.presets : config.presets;
}

export interface BuildAuthUrlOpts {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  email: string;
}

export function buildAuthUrl(config: OAuthProviderConfig, opts: BuildAuthUrlOpts): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    state: opts.state,
    login_hint: opts.email,
    scope: config.scopes.join(' '),
    ...config.extraAuthParams,
  });
  return `${config.authUrl}?${params.toString()}`;
}
