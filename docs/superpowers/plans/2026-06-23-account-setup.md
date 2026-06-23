# Account Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the account-creation entry point and flows (XOAUTH2, IMAP/SMTP, ActiveSync) for the kylins mail client.

**Architecture:** A reusable `<AccountSetupFlow>` component renders full-window when there are zero accounts and as a modal when adding more. A Zustand store drives a step state machine: pick provider → unified email-gateway → (OAuth-pending | IMAP-manual | EAS-manual) → verifying → welcome. OAuth uses the existing Rust loopback server + system browser (PKCE, public clients). All secrets are AES-encrypted at the `accounts.ts` write boundary.

**Tech Stack:** Tauri v2, React 19, TypeScript (strict), Tailwind v4 + CSS vars, Zustand, Vitest + Testing Library. Rust commands already registered in `kylins.client.backend/src/lib.rs`.

## Global Constraints

- Run all frontend commands from `kylins.client.frontend/`. Run a single test file with `npx vitest run tests/path/to/file.test.ts`.
- TypeScript strictness: `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` are on — array access is `T | undefined`; no unused vars.
- SQL uses positional params `$1, $2, …` via `tauri-plugin-sql`; DB rows are snake_case, mapped to camelCase.
- Secrets (`access_token`, `refresh_token`, `oauth_client_secret`, `imap_password`) must pass through `encryptSecret`/`decryptSecret` (`src/services/crypto.ts`) — never write plaintext.
- OAuth providers are **public clients** (PKCE, no embedded secret). Bundled `client_id`s start empty and are filled before release; the Advanced field lets a user supply one in the meantime.
- OAuth loopback redirect URI is fixed: `http://127.0.0.1:17249` (port `17249` must be free and registered with each provider's console).
- Styling uses existing CSS vars (`bg-[var(--surface)]`, `text-[var(--foreground)]`, etc.) from `src/styles/theme.css`. No new CSS files.
- Component prop interfaces are explicit; the flow root wires the store to props so leaf components stay pure and testable.

## File Structure

**New services:**
- `src/services/auth/providers.ts` — provider configs, presets, `buildAuthUrl`, `OAUTH_CALLBACK_PORT`.
- `src/services/auth/userInfo.ts` — Google userinfo fetch + Microsoft `id_token` JWT decode.
- `src/services/auth/accountSetupFlows.ts` — `runOAuthFlow`, `testImapConnection`, `testEasConnection`, account builders, `openExternalUrl`.

**New store:**
- `src/stores/accountSetupStore.ts` — step state machine + bitmask field validation.

**New components** (all under `src/components/account-setup/`):
- `ProviderPicker.tsx` (includes `ProviderButton`), `CredentialsGate.tsx`, `OAuthPendingScreen.tsx`, `ImapManualForm.tsx`, `EasManualForm.tsx`, `VerifyStep.tsx`, `WelcomeScreen.tsx`, `AccountSetupFlow.tsx`.

**Modified:**
- `src/services/accounts.ts` — encrypt secrets on write, decrypt on read.
- `src/App.tsx` — 0-accounts branch + Add-Account modal trigger.
- `kylins.client.frontend/package.json` — add `@tauri-apps/plugin-opener`.

**New tests** under `tests/` mirroring `src/`.

---

### Task 1: Provider config layer

**Files:**
- Create: `kylins.client.frontend/src/services/auth/providers.ts`
- Test: `kylins.client.frontend/tests/services/auth/providers.test.ts`

**Interfaces:**
- Produces: `SetupProviderId`, `ProviderConfig` (union), `PROVIDERS`, `getProvider(id)`, `buildAuthUrl(config, opts)`, `presetsFor(config)`, `OAUTH_CALLBACK_PORT`.
- Consumes: `SecurityMode` from `src/types`.

- [ ] **Step 1: Write the failing test**

Create `tests/services/auth/providers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  getProvider,
  buildAuthUrl,
  presetsFor,
  OAUTH_CALLBACK_PORT,
} from '../../../src/services/auth/providers';

describe('providers', () => {
  it('exposes the six setup providers', () => {
    const ids = Object.keys(PROVIDERS).sort();
    expect(ids).toEqual(['exchange', 'gmail', 'imap', 'microsoft365', 'outlook', 'yahoo']);
  });

  it('marks gmail/outlook/microsoft365 as oauth2', () => {
    expect(getProvider('gmail').authType).toBe('oauth2');
    expect(getProvider('outlook').authType).toBe('oauth2');
    expect(getProvider('microsoft365').authType).toBe('oauth2');
  });

  it('marks yahoo/imap/exchange as password', () => {
    expect(getProvider('yahoo').authType).toBe('password');
    expect(getProvider('imap').authType).toBe('password');
    expect(getProvider('exchange').authType).toBe('password');
  });

  it('builds a google auth url with pkce + offline access', () => {
    const cfg = getProvider('gmail');
    const url = buildAuthUrl(cfg, {
      clientId: 'CID',
      redirectUri: `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`,
      codeChallenge: 'CHALLENGE',
      state: 'STATE',
      email: 'user@gmail.com',
    });
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(url).toContain('client_id=CID');
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge=CHALLENGE');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=STATE');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('login_hint=user%40gmail.com');
  });

  it('returns presets for providers that have them', () => {
    expect(presetsFor(getProvider('gmail'))?.imapHost).toBe('imap.gmail.com');
    expect(presetsFor(getProvider('imap'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/services/auth/providers.test.ts`
Expected: FAIL — `Cannot find module '../../../src/services/auth/providers'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/auth/providers.ts`:
```ts
import type { SecurityMode } from '../../types';

export type SetupProviderId =
  | 'gmail' | 'outlook' | 'microsoft365' | 'yahoo' | 'imap' | 'exchange';

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
  imapHost: 'imap.gmail.com', imapPort: 993, imapSecurity: 'tls',
  smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecurity: 'starttls',
};
const microsoftPresets: ProviderPresets = {
  imapHost: 'outlook.office365.com', imapPort: 993, imapSecurity: 'tls',
  smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecurity: 'starttls',
};
const yahooPresets: ProviderPresets = {
  imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSecurity: 'tls',
  smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecurity: 'tls',
};

export const PROVIDERS: Record<SetupProviderId, ProviderConfig> = {
  gmail: {
    id: 'gmail', name: 'Gmail', authType: 'oauth2', oauthProvider: 'google',
    bundledClientId: '',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    presets: gmailPresets,
  },
  outlook: {
    id: 'outlook', name: 'Outlook', authType: 'oauth2', oauthProvider: 'microsoft',
    bundledClientId: '',
    authUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access', 'openid', 'profile', 'email',
    ],
    extraAuthParams: {},
    presets: microsoftPresets,
  },
  microsoft365: {
    id: 'microsoft365', name: 'Microsoft 365', authType: 'oauth2', oauthProvider: 'microsoft',
    bundledClientId: '',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access', 'openid', 'profile', 'email',
    ],
    extraAuthParams: {},
    presets: microsoftPresets,
  },
  yahoo: {
    id: 'yahoo', name: 'Yahoo', authType: 'password', presets: yahooPresets,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/services/auth/providers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/services/auth/providers.ts tests/services/auth/providers.test.ts
git commit -m "feat(account-setup): add provider config layer"
```

---

### Task 2: Encrypt secrets in accounts service

**Files:**
- Modify: `kylins.client.frontend/src/services/accounts.ts`
- Modify: `kylins.client.frontend/tests/services/accounts.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` from `src/services/crypto.ts`.
- Produces: unchanged public API (`createAccount`, `getAllAccounts`, `getAccountById`, `updateAccount`, `deleteAccount`, `CreateAccountInput`) — but secrets are encrypted at rest and decrypted on read. `rowToAccount` becomes async.

- [ ] **Step 1: Add failing tests for encryption**

Prepend to `tests/services/accounts.test.ts` (after the existing `vi.mock` block at top, add a crypto mock):
```ts
vi.mock('../../src/services/crypto', () => ({
  encryptSecret: vi.fn((plain: string) => Promise.resolve(`enc:${plain}`)),
  decryptSecret: vi.fn((cipher: string) => Promise.resolve(cipher.replace(/^enc:/, ''))),
}));
```
Add these imports at the top:
```ts
import { encryptSecret, decryptSecret } from '../../src/services/crypto';
```
Add these tests inside the existing `describe('accounts', ...)` block:
```ts
  it('encrypts secret fields on create', async () => {
    mockDb.execute.mockResolvedValue({ rowsAffected: 1 });
    mockDb.select.mockResolvedValue([{ id: 'a', email: 'e@x.com', provider: 'imap', is_active: 1, created_at: 1, updated_at: 1 }]);
    await createAccount({
      email: 'e@x.com', provider: 'imap', authMethod: 'password',
      imapPassword: 'secret', accessToken: 'tok', refreshToken: 'ref',
      oauthClientSecret: 'cs',
    } as any);
    const params = mockDb.execute.mock.calls[0][1] as any[];
    // encrypted values written, never plaintext
    expect(params).toContain('enc:secret');
    expect(params).toContain('enc:tok');
    expect(params).toContain('enc:ref');
    expect(params).toContain('enc:cs');
    expect(params).not.toContain('secret');
    expect(encryptSecret).toHaveBeenCalledWith('secret');
  });

  it('decrypts secret fields on read', async () => {
    mockDb.select.mockResolvedValue([{
      id: 'a', email: 'e@x.com', provider: 'imap', auth_method: 'password',
      imap_password: 'enc:secret', access_token: 'enc:tok', refresh_token: 'enc:ref',
      is_active: 1, created_at: 1, updated_at: 1,
    }]);
    const account = await getAccountById('a');
    expect(account!.imapPassword).toBe('secret');
    expect(account!.accessToken).toBe('tok');
    expect(account!.refreshToken).toBe('ref');
    expect(decryptSecret).toHaveBeenCalledWith('enc:secret');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd kylins.client.frontend && npx vitest run tests/services/accounts.test.ts`
Expected: FAIL — secrets passed through unencrypted (`params` contains `'secret'`).

- [ ] **Step 3: Wire encryption into `accounts.ts`**

In `src/services/accounts.ts`:
- Add import at top: `import { encryptSecret, decryptSecret } from './crypto';`
- Replace the `rowToAccount` function with an async version:
```ts
async function decryptField(value: string | null | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  return decryptSecret(value);
}

async function rowToAccount(row: DbAccountRow): Promise<Account> {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    provider: row.provider as MailProvider,
    accessToken: await decryptField(row.access_token),
    refreshToken: await decryptField(row.refresh_token),
    tokenExpiresAt: row.token_expires_at ?? undefined,
    historyId: row.history_id ?? undefined,
    lastSyncAt: row.last_sync_at ?? undefined,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    imapHost: row.imap_host ?? undefined,
    imapPort: row.imap_port ?? undefined,
    imapSecurity: (row.imap_security as SecurityMode) ?? undefined,
    smtpHost: row.smtp_host ?? undefined,
    smtpPort: row.smtp_port ?? undefined,
    smtpSecurity: (row.smtp_security as SecurityMode) ?? undefined,
    authMethod: (row.auth_method as AuthMethod) ?? undefined,
    imapPassword: await decryptField(row.imap_password),
    imapUsername: row.imap_username ?? undefined,
    oauthProvider: row.oauth_provider ?? undefined,
    oauthClientId: row.oauth_client_id ?? undefined,
    oauthClientSecret: await decryptField(row.oauth_client_secret),
    acceptInvalidCerts: row.accept_invalid_certs === 1,
    easUrl: row.eas_url ?? undefined,
    easProtocolVersion: row.eas_protocol_version ?? undefined,
    easDeviceId: row.eas_device_id ?? undefined,
    easPolicyKey: row.eas_policy_key ?? undefined,
    easUserAgent: row.eas_user_agent ?? undefined,
  };
}
```
- In `createAccount`, encrypt before binding. Replace the `db.execute` argument list's secret fields. Concretely, change the values array entries:
```ts
      input.accessToken ? await encryptSecret(input.accessToken) : null,
      input.refreshToken ? await encryptSecret(input.refreshToken) : null,
```
and for IMAP/EAS:
```ts
      input.imapPassword ? await encryptSecret(input.imapPassword) : null,
```
and `oauth_client_secret`:
```ts
      input.oauthClientSecret ? await encryptSecret(input.oauthClientSecret) : null,
```
Leave all non-secret fields unchanged. The `INSERT` column list and `$1..$26` ordering stay identical.
- In `getAllAccounts`: `return Promise.all(rows.map(rowToAccount));`
- In `getAccountById`: `return rows[0] ? await rowToAccount(rows[0]) : null;`
- In `updateAccount`: the `map` transforms run synchronously; encrypt the secret transforms:
```ts
    ['accessToken', 'access_token', async (v) => v ? await encryptSecret(v as string) : null],
```
Wait — the current `map` transforms are synchronous `(v) => string | number | null` and pushed into `values` synchronously. To encrypt, make the loop `await` each transform. Change the loop to:
```ts
  for (const [key, column, transform] of map) {
    const value = updates[key];
    if (value !== undefined) {
      fields.push(`${column} = $${idx++}`);
      values.push(await transform(value));
    }
  }
```
and update the transform type to `(v: unknown) => Promise<string | number | null> | (string | number | null)`. Encrypt the four secret transforms:
```ts
    ['accessToken', 'access_token', (v) => encryptSecret(v as string)],
    ['refreshToken', 'refresh_token', (v) => encryptSecret(v as string)],
    ['imapPassword', 'imap_password', (v) => encryptSecret(v as string)],
    ['oauthClientSecret', 'oauth_client_secret', (v) => encryptSecret(v as string)],
```
(`encryptSecret` already returns `Promise<string>`.) Keep all other transforms as-is.

- [ ] **Step 4: Run all account tests**

Run: `cd kylins.client.frontend && npx vitest run tests/services/accounts.test.ts`
Expected: PASS — existing tests pass (crypto mocked as `enc:` prefix / identity decode), new encryption tests pass.

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/services/accounts.ts tests/services/accounts.test.ts
git commit -m "feat(accounts): encrypt secrets at the persistence boundary"
```

---

### Task 3: Userinfo extraction

**Files:**
- Create: `kylins.client.frontend/src/services/auth/userInfo.ts`
- Test: `kylins.client.frontend/tests/services/auth/userInfo.test.ts`

**Interfaces:**
- Consumes: `OAuthProviderConfig` from `./providers`, `TokenExchangeResult` from `../../types`.
- Produces: `ProviderUserInfo`, `decodeIdTokenClaims(idToken)`, `fetchUserInfo(config, tokens, fallbackEmail)`.

- [ ] **Step 1: Write the failing test**

Create `tests/services/auth/userInfo.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeIdTokenClaims, fetchUserInfo } from '../../../src/services/auth/userInfo';
import { getProvider } from '../../../src/services/auth/providers';
import type { TokenExchangeResult } from '../../../src/types';

describe('userInfo', () => {
  it('decodes a jwt payload (base64url, no signature verification)', () => {
    // header.{"email":"a@b.com","name":"A B"}.sig  — payload is base64url of the JSON
    const payload = btoa(JSON.stringify({ email: 'a@b.com', name: 'A B' })).replace(/=/g, '');
    const jwt = `header.${payload}.signature`;
    const claims = decodeIdTokenClaims(jwt);
    expect(claims.email).toBe('a@b.com');
    expect(claims.name).toBe('A B');
  });

  it('fetches google userinfo from the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ email: 'g@x.com', name: 'G', picture: 'u' }), { status: 200 }),
    );
    const cfg = getProvider('gmail');
    const tokens: TokenExchangeResult = {
      access_token: 'tok', refresh_token: null, expires_in: 3600,
      token_type: 'Bearer', scope: null, id_token: null,
    };
    const info = await fetchUserInfo(cfg, tokens, 'fallback@x.com');
    expect(info.email).toBe('g@x.com');
    expect(info.displayName).toBe('G');
    expect(info.avatarUrl).toBe('u');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    );
    fetchSpy.mockRestore();
  });

  it('parses microsoft id_token instead of calling graph', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cfg = getProvider('outlook');
    const payload = btoa(JSON.stringify({ email: 'm@x.com', preferred_username: 'm@x.com', name: 'M' })).replace(/=/g, '');
    const tokens: TokenExchangeResult = {
      access_token: 'tok', refresh_token: null, expires_in: 3600,
      token_type: 'Bearer', scope: null, id_token: `h.${payload}.s`,
    };
    const info = await fetchUserInfo(cfg, tokens, 'fallback@x.com');
    expect(info.email).toBe('m@x.com');
    expect(info.displayName).toBe('M');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/services/auth/userInfo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/auth/userInfo.ts`:
```ts
import type { TokenExchangeResult } from '../../types';
import type { OAuthProviderConfig } from './providers';

export interface ProviderUserInfo {
  email: string;
  displayName?: string;
  avatarUrl?: string;
}

function base64UrlDecode(segment: string): string {
  const pad = segment.length % 4 === 0 ? '' : '='.repeat(4 - (segment.length % 4));
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const parts = idToken.split('.');
  if (parts.length < 2) throw new Error('Malformed id_token');
  return JSON.parse(base64UrlDecode(parts[1]!));
}

export async function fetchUserInfo(
  config: OAuthProviderConfig,
  tokens: TokenExchangeResult,
  fallbackEmail: string,
): Promise<ProviderUserInfo> {
  if (config.oauthProvider === 'microsoft') {
    if (!tokens.id_token) return { email: fallbackEmail };
    const claims = decodeIdTokenClaims(tokens.id_token);
    const email =
      (claims.email as string) ||
      (claims.preferred_username as string) ||
      fallbackEmail;
    return {
      email,
      displayName: claims.name as string | undefined,
    };
  }

  // Google: call userinfo endpoint.
  if (!config.userInfoUrl) return { email: fallbackEmail };
  const res = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!res.ok) return { email: fallbackEmail };
  const body = (await res.json()) as { email?: string; name?: string; picture?: string };
  return {
    email: body.email ?? fallbackEmail,
    displayName: body.name,
    avatarUrl: body.picture,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/services/auth/userInfo.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/services/auth/userInfo.ts tests/services/auth/userInfo.test.ts
git commit -m "feat(account-setup): add userinfo extraction (google + ms id_token)"
```

---

### Task 4: Account-setup store + bitmask validation

**Files:**
- Create: `kylins.client.frontend/src/stores/accountSetupStore.ts`
- Test: `kylins.client.frontend/tests/stores/accountSetupStore.test.ts`

**Interfaces:**
- Consumes: `SetupProviderId`, `ProviderConfig`, `getProvider`, `presetsFor` from `src/services/auth/providers`.
- Produces: `SetupStep`, `RequiredField`, `flagsComplete`, `emailValid`, `useAccountSetupStore`.

- [ ] **Step 1: Write the failing test**

Create `tests/stores/accountSetupStore.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useAccountSetupStore, flagsComplete, emailValid, RequiredField } from '../../src/stores/accountSetupStore';

beforeEach(() => useAccountSetupStore.getState().reset());

describe('accountSetupStore', () => {
  it('flagsComplete returns true only when all required flags are present', () => {
    expect(flagsComplete(RequiredField.Email, RequiredField.Email)).toBe(true);
    expect(flagsComplete(RequiredField.Email | RequiredField.Password, RequiredField.Email)).toBe(false);
  });

  it('emailValid accepts basic addresses', () => {
    expect(emailValid('a@b.com')).toBe(true);
    expect(emailValid('nope')).toBe(false);
  });

  it('selectProvider moves to gateway and records authType', () => {
    useAccountSetupStore.getState().selectProvider('gmail');
    expect(useAccountSetupStore.getState().step).toBe('gateway');
    expect(useAccountSetupStore.getState().providerId).toBe('gmail');
  });

  it('required mask for oauth provider is email only; for password is email+password', () => {
    useAccountSetupStore.getState().selectProvider('gmail');
    expect(useAccountSetupStore.getState().requiredMask).toBe(RequiredField.Email);
    useAccountSetupStore.getState().selectProvider('yahoo');
    expect(useAccountSetupStore.getState().requiredMask).toBe(RequiredField.Email | RequiredField.Password);
  });

  it('canSubmit reflects required fields being valid', () => {
    useAccountSetupStore.getState().selectProvider('yahoo');
    expect(useAccountSetupStore.getState().canSubmit()).toBe(false);
    useAccountSetupStore.getState().setEmail('a@b.com');
    useAccountSetupStore.getState().setPassword('pass');
    expect(useAccountSetupStore.getState().canSubmit()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/accountSetupStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/stores/accountSetupStore.ts`:
```ts
import { create } from 'zustand';
import type { SetupProviderId, ProviderConfig } from '../services/auth/providers';
import { getProvider, presetsFor } from '../services/auth/providers';
import type { SecurityMode } from '../types';

export type SetupStep =
  | 'pick' | 'gateway' | 'oauth-pending' | 'imap-manual'
  | 'eas-manual' | 'verifying' | 'welcome' | 'error';

export enum RequiredField {
  None = 0,
  Email = 1 << 0,
  Password = 1 << 1,
  ImapServer = 1 << 2,
  ImapPort = 1 << 3,
  SmtpServer = 1 << 4,
  SmtpPort = 1 << 5,
  EasServer = 1 << 6,
}

export function flagsComplete(required: RequiredField, actual: RequiredField): boolean {
  return (actual & required) === required;
}

export function emailValid(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

function providerRequiredMask(config: ProviderConfig): RequiredField {
  return config.authType === 'oauth2' ? RequiredField.Email : RequiredField.Email | RequiredField.Password;
}

export interface AccountSetupState {
  step: SetupStep;
  providerId: SetupProviderId | null;
  config: ProviderConfig | null;
  requiredMask: RequiredField;
  email: string;
  password: string;
  advancedClientId: string;
  advancedClientSecret: string;
  imapHost: string; imapPort: string; imapSecurity: SecurityMode;
  smtpHost: string; smtpPort: string; smtpSecurity: SecurityMode;
  easServer: string;
  deviceId: string;
  acceptInvalidCerts: boolean;
  error: string | null;
  selectProvider: (id: SetupProviderId) => void;
  setStep: (step: SetupStep) => void;
  setEmail: (v: string) => void;
  setPassword: (v: string) => void;
  setAdvancedClientId: (v: string) => void;
  setAdvancedClientSecret: (v: string) => void;
  setImap: (patch: Partial<Pick<AccountSetupState, 'imapHost' | 'imapPort' | 'imapSecurity'>>) => void;
  setSmtp: (patch: Partial<Pick<AccountSetupState, 'smtpHost' | 'smtpPort' | 'smtpSecurity'>>) => void;
  setEasServer: (v: string) => void;
  setDeviceId: (v: string) => void;
  setError: (e: string | null) => void;
  back: () => void;
  canSubmit: () => boolean;
  reset: () => void;
}

function initialForm() {
  return {
    email: '', password: '', advancedClientId: '', advancedClientSecret: '',
    imapHost: '', imapPort: '993', imapSecurity: 'tls' as SecurityMode,
    smtpHost: '', smtpPort: '587', smtpSecurity: 'starttls' as SecurityMode,
    easServer: '', deviceId: '', acceptInvalidCerts: false, error: null,
  };
}

export const useAccountSetupStore = create<AccountSetupState>((set, get) => ({
  step: 'pick',
  providerId: null,
  config: null,
  requiredMask: RequiredField.None,
  ...initialForm(),
  selectProvider: (id) => {
    const config = getProvider(id);
    const base = { providerId: id, config, requiredMask: providerRequiredMask(config), step: 'gateway' as SetupStep };
    if (config.authType === 'password' && config.presets) {
      set({ ...base, ...initialForm(),
        imapHost: config.presets.imapHost, imapPort: String(config.presets.imapPort),
        imapSecurity: config.presets.imapSecurity,
        smtpHost: config.presets.smtpHost, smtpPort: String(config.presets.smtpPort),
        smtpSecurity: config.presets.smtpSecurity,
      });
    } else {
      set({ ...base, ...initialForm() });
    }
  },
  setStep: (step) => set({ step }),
  setEmail: (email) => set({ email }),
  setPassword: (password) => set({ password }),
  setAdvancedClientId: (advancedClientId) => set({ advancedClientId }),
  setAdvancedClientSecret: (advancedClientSecret) => set({ advancedClientSecret }),
  setImap: (patch) => set(patch),
  setSmtp: (patch) => set(patch),
  setEasServer: (easServer) => set({ easServer }),
  setDeviceId: (deviceId) => set({ deviceId }),
  setError: (error) => set({ error }),
  back: () => {
    const s = get();
    if (s.step === 'gateway' || s.step === 'oauth-pending') set({ step: 'pick', error: null });
    else if (s.step === 'imap-manual' || s.step === 'eas-manual') set({ step: 'gateway', error: null });
    else set({ step: 'gateway', error: null });
  },
  canSubmit: () => {
    const s = get();
    if (!s.config) return false;
    let actual = RequiredField.None;
    if (emailValid(s.email)) actual |= RequiredField.Email;
    if (s.password.trim().length >= 3) actual |= RequiredField.Password;
    return flagsComplete(s.requiredMask, actual);
  },
  reset: () => set({ step: 'pick', providerId: null, config: null, requiredMask: RequiredField.None, ...initialForm() }),
}));

// Re-export so components can read presets without a second import path.
export function providerPresets(config: ProviderConfig | null) {
  return config ? presetsFor(config) : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/stores/accountSetupStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/stores/accountSetupStore.ts tests/stores/accountSetupStore.test.ts
git commit -m "feat(account-setup): add wizard store + bitmask validation"
```

---

### Task 5: Flow orchestrators + opener dependency

**Files:**
- Create: `kylins.client.frontend/src/services/auth/accountSetupFlows.ts`
- Test: `kylins.client.frontend/tests/services/auth/accountSetupFlows.test.ts`
- Modify: `kylins.client.frontend/package.json` (add `@tauri-apps/plugin-opener`)

**Interfaces:**
- Consumes: `oauth.ts` (`generateCodeVerifier`, `generateCodeChallenge`, `generateState`, `startOAuthServer`, `exchangeToken`), `ImapProvider`, `EasProvider`, `smtpSender.testConnection`, `./providers`, `./userInfo`, `CreateAccountInput` from `../../services/accounts`.
- Produces: `openExternalUrl`, `runOAuthFlow`, `testImapConnection`, `testEasConnection`, `buildOAuthImapAccount`, `buildImapAccount`, `buildEasAccount`, `newDeviceId`.

- [ ] **Step 1: Add the opener dependency**

Run:
```bash
cd kylins.client.frontend && npm install @tauri-apps/plugin-opener@^2.2.0
```
Expected: package added to `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `tests/services/auth/accountSetupFlows.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { buildOAuthImapAccount, buildImapAccount, buildEasAccount, runOAuthFlow, testImapConnection } from '../../../src/services/auth/accountSetupFlows';
import { getProvider } from '../../../src/services/auth/providers';

describe('accountSetupFlows', () => {
  beforeEach(() => invokeMock.mockReset());

  it('buildOAuthImapAccount maps tokens+userinfo into an imap+xoauth2 account', () => {
    const cfg = getProvider('gmail');
    const acc = buildOAuthImapAccount(
      cfg,
      { email: 'g@x.com', displayName: 'G' },
      { access_token: 'tok', refresh_token: 'ref', expires_in: 3600, token_type: 'Bearer', scope: null, id_token: null },
      'CID',
    );
    expect(acc.provider).toBe('imap');
    expect(acc.authMethod).toBe('oauth2');
    expect(acc.oauthProvider).toBe('google');
    expect(acc.oauthClientId).toBe('CID');
    expect(acc.accessToken).toBe('tok');
    expect(acc.refreshToken).toBe('ref');
    expect(acc.imapHost).toBe('imap.gmail.com');
    expect(acc.smtpPort).toBe(587);
    expect(acc.email).toBe('g@x.com');
  });

  it('buildImapAccount maps a password provider with presets', () => {
    const acc = buildImapAccount(getProvider('yahoo'), 'y@yahoo.com', 'apppass');
    expect(acc.provider).toBe('imap');
    expect(acc.authMethod).toBe('password');
    expect(acc.imapPassword).toBe('apppass');
    expect(acc.imapHost).toBe('imap.mail.yahoo.com');
  });

  it('buildEasAccount maps an eas account', () => {
    const acc = buildEasAccount('e@ex.com', 'pw', 'https://ex.com/Microsoft-Server-ActiveSync', 'DEV-1');
    expect(acc.provider).toBe('eas');
    expect(acc.easUrl).toBe('https://ex.com/Microsoft-Server-ActiveSync');
    expect(acc.easDeviceId).toBe('DEV-1');
    expect(acc.easProtocolVersion).toBe('16.1');
  });

  it('runOAuthFlow starts server, opens browser, exchanges code', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'start_oauth_server') return Promise.resolve({ code: 'CODE', state: 'STATE' });
      if (cmd === 'oauth_exchange_token') return Promise.resolve({
        access_token: 'tok', refresh_token: 'ref', expires_in: 3600,
        token_type: 'Bearer', scope: null, id_token: null,
      });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ email: 'g@x.com' }), { status: 200 }),
    );
    const { tokens, userInfo } = await runOAuthFlow(getProvider('gmail'), { email: 'g@x.com', clientId: 'CID' });
    expect(tokens.access_token).toBe('tok');
    expect(userInfo.email).toBe('g@x.com');
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('start_oauth_server');
    expect(cmds).toContain('oauth_exchange_token');
    fetchSpy.mockRestore();
  });

  it('testImapConnection throws when imap_test_connection fails', async () => {
    invokeMock.mockResolvedValue('Connection failed: auth error');
    const account = buildImapAccount(getProvider('yahoo'), 'y@yahoo.com', 'apppass') as any;
    await expect(testImapConnection(account)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/services/auth/accountSetupFlows.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

Create `src/services/auth/accountSetupFlows.ts`:
```ts
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Account } from '../../types';
import type { CreateAccountInput } from '../accounts';
import {
  generateCodeVerifier, generateCodeChallenge, generateState,
  startOAuthServer, exchangeToken,
} from './oauth';
import type { OAuthProviderConfig, PasswordProviderConfig, ProviderConfig } from './providers';
import { OAUTH_CALLBACK_PORT, presetsFor } from './providers';
import { fetchUserInfo, type ProviderUserInfo } from './userInfo';
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
  opts: { email: string; clientId?: string; clientSecret?: string },
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
  const redirectUri = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`;
  const authUrl = (await import('./providers')).buildAuthUrl(config, {
    clientId, redirectUri, codeChallenge: challenge, state, email: opts.email,
  });

  const serverPromise = startOAuthServer(OAUTH_CALLBACK_PORT, state);
  await openExternalUrl(authUrl);
  const { code } = await serverPromise;

  const tokens = await exchangeToken({
    tokenUrl: config.tokenUrl,
    code,
    clientId,
    redirectUri,
    codeVerifier: verifier,
    clientSecret: opts.clientSecret,
    scope: config.scopes.join(' '),
  });
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
    authMethod: 'oauth2',
    oauthProvider: config.oauthProvider,
    oauthClientId: clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? undefined,
    tokenExpiresAt,
    imapHost: p.imapHost, imapPort: p.imapPort, imapSecurity: p.imapSecurity,
    smtpHost: p.smtpHost, smtpPort: p.smtpPort, smtpSecurity: p.smtpSecurity,
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
    authMethod: 'password',
    imapPassword: password,
    imapUsername: email,
    imapHost: p?.imapHost, imapPort: p?.imapPort, imapSecurity: p?.imapSecurity,
    smtpHost: p?.smtpHost, smtpPort: p?.smtpPort, smtpSecurity: p?.smtpSecurity,
  };
}

export function buildEasAccount(
  email: string,
  password: string,
  serverUrl: string,
  deviceId: string,
): CreateAccountInput {
  return {
    email,
    provider: 'eas',
    imapUsername: email,
    imapPassword: password,
    easUrl: serverUrl,
    easProtocolVersion: '16.1',
    easDeviceId: deviceId,
  };
}

// satisfy ProviderConfig import for callers that pass either kind
export type { ProviderConfig };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/services/auth/accountSetupFlows.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
cd kylins.client.frontend && git add src/services/auth/accountSetupFlows.ts tests/services/auth/accountSetupFlows.test.ts package.json package-lock.json
git commit -m "feat(account-setup): add oauth/imap/eas orchestrators + opener dep"
```

---

### Task 6: Provider picker component

**Files:**
- Create: `kylins.client.frontend/src/components/account-setup/ProviderPicker.tsx`
- Test: `kylins.client.frontend/tests/components/account-setup/ProviderPicker.test.tsx`

**Interfaces:**
- Consumes: `PROVIDERS`, `SetupProviderId` from `@/services/auth/providers`.
- Produces: `ProviderPicker` (props: `{ onPick: (id: SetupProviderId) => void }`) and internal `ProviderButton`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/account-setup/ProviderPicker.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ProviderPicker } from '../../../src/components/account-setup/ProviderPicker';

describe('ProviderPicker', () => {
  it('renders the six provider tiles and fires onPick', () => {
    const onPick = vi.fn();
    const { getByText } = render(<ProviderPicker onPick={onPick} />);
    expect(getByText('Gmail')).toBeInTheDocument();
    expect(getByText('Outlook')).toBeInTheDocument();
    expect(getByText('Microsoft 365')).toBeInTheDocument();
    expect(getByText('Yahoo')).toBeInTheDocument();
    expect(getByText('Other (IMAP/SMTP)')).toBeInTheDocument();
    expect(getByText('Exchange (ActiveSync)')).toBeInTheDocument();
    fireEvent.click(getByText('Gmail'));
    expect(onPick).toHaveBeenCalledWith('gmail');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/ProviderPicker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/account-setup/ProviderPicker.tsx`:
```tsx
import { PROVIDERS } from '../../services/auth/providers';
import type { SetupProviderId } from '../../services/auth/providers';

const TILE_ORDER: SetupProviderId[] = ['gmail', 'outlook', 'microsoft365', 'yahoo', 'imap', 'exchange'];

export interface ProviderPickerProps {
  onPick: (id: SetupProviderId) => void;
}

function ProviderButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <span className="grid h-8 w-8 place-items-center rounded-md bg-[var(--muted)] text-xs font-bold">
        {name.charAt(0)}
      </span>
      {name}
    </button>
  );
}

export function ProviderPicker({ onPick }: ProviderPickerProps) {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <h1 className="text-center text-2xl font-semibold text-[var(--foreground)]">Add an account</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {TILE_ORDER.map((id) => (
          <ProviderButton key={id} name={PROVIDERS[id].name} onClick={() => onPick(id)} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/ProviderPicker.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/components/account-setup/ProviderPicker.tsx tests/components/account-setup/ProviderPicker.test.tsx
git commit -m "feat(account-setup): add provider picker"
```

---

### Task 7: Credentials gateway component

**Files:**
- Create: `kylins.client.frontend/src/components/account-setup/CredentialsGate.tsx`
- Test: `kylins.client.frontend/tests/components/account-setup/CredentialsGate.test.tsx`

**Interfaces:**
- Consumes: `ProviderConfig` from `@/services/auth/providers`.
- Produces: `CredentialsGate` with props `{ config, email, password, advancedClientId, advancedClientSecret, onChange, onSignIn, onManualSetup, canSubmit }`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/account-setup/CredentialsGate.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CredentialsGate } from '../../../src/components/account-setup/CredentialsGate';
import { getProvider } from '../../../src/services/auth/providers';

describe('CredentialsGate', () => {
  it('hides the password field for oauth providers', () => {
    const { queryByLabelText, getByPlaceholderText } = render(
      <CredentialsGate
        config={getProvider('gmail')} email="" password=""
        advancedClientId="" advancedClientSecret={() => {}}
        onChange={() => {}} onSignIn={() => {}} onManualSetup={() => {}} canSubmit={false}
      />,
    );
    expect(queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(getByPlaceholderText(/email/i)).toBeInTheDocument();
  });

  it('shows the password field for password providers and emits sign-in', () => {
    const onSignIn = vi.fn();
    const { getByLabelText, getByText } = render(
      <CredentialsGate
        config={getProvider('yahoo')} email="" password=""
        advancedClientId="" advancedClientSecret={() => {}}
        onChange={() => {}} onSignIn={onSignIn} onManualSetup={() => {}} canSubmit
      />,
    );
    expect(getByLabelText(/password/i)).toBeInTheDocument();
    fireEvent.click(getByText(/sign in/i));
    expect(onSignIn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/CredentialsGate.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/account-setup/CredentialsGate.tsx`:
```tsx
import { useState } from 'react';
import type { ProviderConfig } from '../../services/auth/providers';

export interface CredentialsGateProps {
  config: ProviderConfig;
  email: string;
  password: string;
  advancedClientId: string;
  advancedClientSecret: string;
  onChange: (patch: Partial<{ email: string; password: string; advancedClientId: string; advancedClientSecret: string }>) => void;
  onSignIn: () => void;
  onManualSetup: () => void;
  canSubmit: boolean;
}

const inputClass =
  'w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]';

export function CredentialsGate({
  config, email, password, advancedClientId, advancedClientSecret,
  onChange, onSignIn, onManualSetup, canSubmit,
}: CredentialsGateProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isOAuth = config.authType === 'oauth2';

  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Add your {config.name} account</h1>

      <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
        Email
        <input
          className={inputClass}
          placeholder="you@example.com"
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
        <button type="button" className="text-sm text-[var(--muted-text)] underline" onClick={onManualSetup}>
          Manual setup
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSignIn}
          className="rounded bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-40"
        >
          {isOAuth ? 'Sign in' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/CredentialsGate.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/components/account-setup/CredentialsGate.tsx tests/components/account-setup/CredentialsGate.test.tsx
git commit -m "feat(account-setup): add unified credentials gateway"
```

---

### Task 8: OAuth pending screen

**Files:**
- Create: `kylins.client.frontend/src/components/account-setup/OAuthPendingScreen.tsx`
- Test: `kylins.client.frontend/tests/components/account-setup/OAuthPendingScreen.test.tsx`

**Interfaces:**
- Produces: `OAuthPendingScreen` props `{ providerName, fallbackUrl, onCancel }`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/account-setup/OAuthPendingScreen.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { OAuthPendingScreen } from '../../../src/components/account-setup/OAuthPendingScreen';

describe('OAuthPendingScreen', () => {
  it('renders the provider name and a copyable fallback url', () => {
    const { getByText, getByDisplayValue } = render(
      <OAuthPendingScreen providerName="Google" fallbackUrl="https://accounts.google.com/x?client_id=CID" onCancel={vi.fn()} />,
    );
    expect(getByText(/Sign in with Google in your browser/i)).toBeInTheDocument();
    expect(getByDisplayValue(/client_id=CID/)).toBeInTheDocument();
  });

  it('fires onCancel', () => {
    const onCancel = vi.fn();
    const { getByText } = render(
      <OAuthPendingScreen providerName="Google" fallbackUrl="u" onCancel={onCancel} />,
    );
    fireEvent.click(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/OAuthPendingScreen.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/account-setup/OAuthPendingScreen.tsx`:
```tsx
import { useState } from 'react';

export interface OAuthPendingScreenProps {
  providerName: string;
  fallbackUrl: string;
  onCancel: () => void;
}

export function OAuthPendingScreen({ providerName, fallbackUrl, onCancel }: OAuthPendingScreenProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(fallbackUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">
        Sign in with {providerName} in your browser.
      </h1>
      <p className="text-sm text-[var(--muted-text)]">Page didn’t open? Paste this URL into your browser:</p>
      <div className="flex w-full items-center gap-2">
        <input readOnly value={fallbackUrl} className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)]" />
        <button type="button" onClick={copy} className="rounded border border-[var(--border)] px-3 py-2 text-xs text-[var(--foreground)]">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="flex items-center gap-2 text-sm text-[var(--muted-text)]">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
        Waiting for sign-in…
      </div>
      <button type="button" onClick={onCancel} className="text-sm text-[var(--muted-text)] underline">
        Cancel
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/OAuthPendingScreen.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/components/account-setup/OAuthPendingScreen.tsx tests/components/account-setup/OAuthPendingScreen.test.tsx
git commit -m "feat(account-setup): add oauth pending screen"
```

---

### Task 9: IMAP manual form

**Files:**
- Create: `kylins.client.frontend/src/components/account-setup/ImapManualForm.tsx`
- Test: `kylins.client.frontend/tests/components/account-setup/ImapManualForm.test.tsx`

**Interfaces:**
- Produces: `ImapManualForm` props bound to IMAP/SMTP host/port/security values with `onChange` + `onSubmit` + `canSubmit`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/account-setup/ImapManualForm.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ImapManualForm, type ImapManualValues } from '../../../src/components/account-setup/ImapManualForm';

const values: ImapManualValues = {
  imapHost: 'imap.x.com', imapPort: '993', imapSecurity: 'tls',
  smtpHost: 'smtp.x.com', smtpPort: '587', smtpSecurity: 'starttls',
};

describe('ImapManualForm', () => {
  it('edits imap host and submits', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { getByDisplayValue, getByText } = render(
      <ImapManualForm values={values} onChange={onChange} onSubmit={onSubmit} canSubmit />,
    );
    fireEvent.change(getByDisplayValue('imap.x.com'), { target: { value: 'new.imap.com' } });
    expect(onChange).toHaveBeenCalledWith({ imapHost: 'new.imap.com' });
    fireEvent.click(getByText(/sign in/i));
    expect(onSubmit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/ImapManualForm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/account-setup/ImapManualForm.tsx`:
```tsx
import type { SecurityMode } from '../../types';

export interface ImapManualValues {
  imapHost: string; imapPort: string; imapSecurity: SecurityMode;
  smtpHost: string; smtpPort: string; smtpSecurity: SecurityMode;
}

export interface ImapManualFormProps {
  values: ImapManualValues;
  onChange: (patch: Partial<ImapManualValues>) => void;
  onSubmit: () => void;
  canSubmit: boolean;
}

const inputClass = 'w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]';
const labelClass = 'flex flex-col gap-1 text-sm text-[var(--foreground)]';

export function ImapManualForm({ values, onChange, onSubmit, canSubmit }: ImapManualFormProps) {
  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Server settings</h1>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold text-[var(--foreground)]">Incoming (IMAP)</legend>
        <label className={labelClass}>Server
          <input className={inputClass} value={values.imapHost} onChange={(e) => onChange({ imapHost: e.target.value })} />
        </label>
        <label className={labelClass}>Port
          <input className={inputClass} value={values.imapPort} onChange={(e) => onChange({ imapPort: e.target.value })} />
        </label>
        <label className={labelClass}>Security
          <select className={inputClass} value={values.imapSecurity} onChange={(e) => onChange({ imapSecurity: e.target.value as SecurityMode })}>
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold text-[var(--foreground)]">Outgoing (SMTP)</legend>
        <label className={labelClass}>Server
          <input className={inputClass} value={values.smtpHost} onChange={(e) => onChange({ smtpHost: e.target.value })} />
        </label>
        <label className={labelClass}>Port
          <input className={inputClass} value={values.smtpPort} onChange={(e) => onChange({ smtpPort: e.target.value })} />
        </label>
        <label className={labelClass}>Security
          <select className={inputClass} value={values.smtpSecurity} onChange={(e) => onChange({ smtpSecurity: e.target.value as SecurityMode })}>
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </label>
      </fieldset>

      <button type="button" disabled={!canSubmit} onClick={onSubmit}
        className="self-end rounded bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-40">
        Sign in
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/ImapManualForm.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/components/account-setup/ImapManualForm.tsx tests/components/account-setup/ImapManualForm.test.tsx
git commit -m "feat(account-setup): add imap manual settings form"
```

---

### Task 10: EAS manual form

**Files:**
- Create: `kylins.client.frontend/src/components/account-setup/EasManualForm.tsx`
- Test: `kylins.client.frontend/tests/components/account-setup/EasManualForm.test.tsx`

**Interfaces:**
- Produces: `EasManualForm` props `{ server, deviceId, onChange, onSubmit, canSubmit }`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/account-setup/EasManualForm.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { EasManualForm } from '../../../src/components/account-setup/EasManualForm';

describe('EasManualForm', () => {
  it('shows the device id and submits', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { getByDisplayValue, getByText } = render(
      <EasManualForm server="https://ex.com/Microsoft-Server-ActiveSync" deviceId="DEV-1"
        onChange={onChange} onSubmit={onSubmit} canSubmit />,
    );
    expect(getByDisplayValue('DEV-1')).toBeInTheDocument();
    fireEvent.click(getByText(/sign in/i));
    expect(onSubmit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/EasManualForm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/account-setup/EasManualForm.tsx`:
```tsx
export interface EasManualFormProps {
  server: string;
  deviceId: string;
  onChange: (patch: Partial<{ server: string; deviceId: string }>) => void;
  onSubmit: () => void;
  canSubmit: boolean;
}

const inputClass = 'w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]';
const labelClass = 'flex flex-col gap-1 text-sm text-[var(--foreground)]';

export function EasManualForm({ server, deviceId, onChange, onSubmit, canSubmit }: EasManualFormProps) {
  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">Exchange server</h1>
      <label className={labelClass}>Server URL
        <input className={inputClass} value={server} onChange={(e) => onChange({ server: e.target.value })} />
      </label>
      <label className={labelClass}>Device ID
        <input className={inputClass} value={deviceId} onChange={(e) => onChange({ deviceId: e.target.value })} />
      </label>
      <button type="button" disabled={!canSubmit} onClick={onSubmit}
        className="self-end rounded bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] disabled:opacity-40">
        Sign in
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/EasManualForm.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/components/account-setup/EasManualForm.tsx tests/components/account-setup/EasManualForm.test.tsx
git commit -m "feat(account-setup): add exchange manual form"
```

---

### Task 11: Verify + Welcome screens

**Files:**
- Create: `kylins.client.frontend/src/components/account-setup/VerifyStep.tsx`
- Create: `kylins.client.frontend/src/components/account-setup/WelcomeScreen.tsx`
- Test: `kylins.client.frontend/tests/components/account-setup/VerifyAndWelcome.test.tsx`

**Interfaces:**
- Produces: `VerifyStep` props `{ error?: string | null; onRetry?: () => void; onBack?: () => void }`, `WelcomeScreen` props `{ onDone: () => void }`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/account-setup/VerifyAndWelcome.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { VerifyStep } from '../../../src/components/account-setup/VerifyStep';
import { WelcomeScreen } from '../../../src/components/account-setup/WelcomeScreen';

describe('VerifyStep', () => {
  it('shows the error and retry', () => {
    const onRetry = vi.fn();
    const { getByText } = render(<VerifyStep error="bad creds" onRetry={onRetry} onBack={() => {}} />);
    expect(getByText(/bad creds/)).toBeInTheDocument();
    fireEvent.click(getByText(/retry/i));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('WelcomeScreen', () => {
  it('fires onDone', () => {
    const onDone = vi.fn();
    const { getByText } = render(<WelcomeScreen onDone={onDone} />);
    fireEvent.click(getByText(/looks good/i));
    expect(onDone).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/VerifyAndWelcome.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementations**

Create `src/components/account-setup/VerifyStep.tsx`:
```tsx
export interface VerifyStepProps {
  error?: string | null;
  onRetry?: () => void;
  onBack?: () => void;
}

export function VerifyStep({ error, onRetry, onBack }: VerifyStepProps) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
      {error ? (
        <>
          <h1 className="text-xl font-semibold text-[var(--destructive)]">Couldn’t connect</h1>
          <p className="text-sm text-[var(--muted-text)]">{error}</p>
          <div className="flex gap-3">
            {onBack && <button type="button" onClick={onBack} className="rounded border border-[var(--border)] px-4 py-2 text-sm">Back</button>}
            {onRetry && <button type="button" onClick={onRetry} className="rounded bg-[var(--primary)] px-4 py-2 text-sm text-[var(--primary-foreground)]">Retry</button>}
          </div>
        </>
      ) : (
        <>
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
          <p className="text-sm text-[var(--muted-text)]">Connecting…</p>
        </>
      )}
    </div>
  );
}
```

Create `src/components/account-setup/WelcomeScreen.tsx`:
```tsx
export interface WelcomeScreenProps {
  onDone: () => void;
}

export function WelcomeScreen({ onDone }: WelcomeScreenProps) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
      <h1 className="text-2xl font-semibold text-[var(--foreground)]">Welcome to Kylins Mail</h1>
      <p className="text-sm text-[var(--muted-text)]">Your account is connected. Let’s open your inbox.</p>
      <button type="button" onClick={onDone}
        className="rounded bg-[var(--primary)] px-5 py-2 text-sm font-medium text-[var(--primary-foreground)]">
        Looks good!
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/VerifyAndWelcome.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/components/account-setup/VerifyStep.tsx src/components/account-setup/WelcomeScreen.tsx tests/components/account-setup/VerifyAndWelcome.test.tsx
git commit -m "feat(account-setup): add verify + welcome screens"
```

---

### Task 12: Account setup flow root

**Files:**
- Create: `kylins.client.frontend/src/components/account-setup/AccountSetupFlow.tsx`
- Test: `kylins.client.frontend/tests/components/account-setup/AccountSetupFlow.test.tsx`

**Interfaces:**
- Consumes: `useAccountSetupStore`; all leaf components; orchestrators + builders from `@/services/auth/accountSetupFlows`; `createAccount`, `getAllAccounts` from `@/services/accounts`; `useAccountStore` from `@/stores/accountStore`.
- Produces: `AccountSetupFlow` props `{ variant: 'fullscreen' | 'modal'; onComplete: () => void }`.

- [ ] **Step 1: Write the failing test**

Create `tests/components/account-setup/AccountSetupFlow.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import { render, fireEvent } from '@testing-library/react';
import { AccountSetupFlow } from '../../../src/components/account-setup/AccountSetupFlow';
import { useAccountSetupStore } from '../../../src/stores/accountSetupStore';

describe('AccountSetupFlow', () => {
  beforeEach(() => useAccountSetupStore.getState().reset());

  it('renders the picker first and advances to gateway on pick', () => {
    const onComplete = vi.fn();
    const { getByText, queryByText } = render(<AccountSetupFlow variant="modal" onComplete={onComplete} />);
    expect(getByText('Add an account')).toBeInTheDocument();
    fireEvent.click(getByText('Yahoo'));
    // gateway visible (password field shown for yahoo)
    expect(queryByText(/Add your Yahoo account/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/AccountSetupFlow.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/account-setup/AccountSetupFlow.tsx`:
```tsx
import { useAccountSetupStore } from '../../stores/accountSetupStore';
import { ProviderPicker } from './ProviderPicker';
import { CredentialsGate } from './CredentialsGate';
import { OAuthPendingScreen } from './OAuthPendingScreen';
import { ImapManualForm } from './ImapManualForm';
import { EasManualForm } from './EasManualForm';
import { VerifyStep } from './VerifyStep';
import { WelcomeScreen } from './WelcomeScreen';
import {
  runOAuthFlow, testImapConnection, testEasConnection,
  buildOAuthImapAccount, buildImapAccount, buildEasAccount, newDeviceId,
} from '../../services/auth/accountSetupFlows';
import { createAccount } from '../../services/accounts';
import { useAccountStore } from '../../stores/accountStore';

export interface AccountSetupFlowProps {
  variant: 'fullscreen' | 'modal';
  onComplete: () => void;
}

const shellClass = (variant: 'fullscreen' | 'modal') =>
  variant === 'fullscreen'
    ? 'flex h-screen w-screen items-center justify-center bg-[var(--background)] p-8'
    : 'flex h-full w-full items-center justify-center bg-[var(--background)] p-8';

export function AccountSetupFlow({ variant, onComplete }: AccountSetupFlowProps) {
  const s = useAccountSetupStore();

  async function handleOAuth() {
    if (!s.config || s.config.authType !== 'oauth2') return;
    s.setStep('oauth-pending');
    try {
      const { tokens, userInfo } = await runOAuthFlow(s.config, {
        email: s.email,
        clientId: s.advancedClientId || undefined,
        clientSecret: s.advancedClientSecret || undefined,
      });
      s.setStep('verifying');
      const input = buildOAuthImapAccount(s.config, userInfo, tokens, s.advancedClientId || s.config.bundledClientId);
      await createAccount(input);
      s.setStep('welcome');
    } catch (e) {
      s.setError((e as Error).message);
      s.setStep('error');
    }
  }

  async function handleImapPassword(useManual?: boolean) {
    if (!s.config || s.config.authType !== 'password') return;
    s.setStep('verifying');
    s.setError(null);
    const input = buildImapAccount(s.config, s.email, s.password);
    if (useManual) {
      input.imapHost = s.imapHost; input.imapPort = Number(s.imapPort) || 993; input.imapSecurity = s.imapSecurity;
      input.smtpHost = s.smtpHost; input.smtpPort = Number(s.smtpPort) || 587; input.smtpSecurity = s.smtpSecurity;
    }
    try {
      await testImapConnection({ ...input, id: 'tmp', email: s.email, isActive: true, createdAt: 0, updatedAt: 0 } as any);
      await createAccount(input);
      s.setStep('welcome');
    } catch (e) {
      s.setError((e as Error).message);
      s.setStep('error');
    }
  }

  async function handleEas() {
    if (!s.config) return;
    s.setStep('verifying');
    s.setError(null);
    const deviceId = s.deviceId || newDeviceId();
    const server = s.easServer || `https://${s.email.split('@')[1]}/Microsoft-Server-ActiveSync`;
    const input = buildEasAccount(s.email, s.password, server, deviceId);
    try {
      await testEasConnection({ ...input, id: 'tmp', email: s.email, isActive: true, createdAt: 0, updatedAt: 0 } as any);
      await createAccount(input);
      s.setStep('welcome');
    } catch (e) {
      s.setError((e as Error).message);
      s.setStep('error');
    }
  }

  function onSignIn() {
    if (!s.config) return;
    if (s.config.authType === 'oauth2') void handleOAuth();
    else if (s.config.id === 'exchange') void handleEas();
    else void handleImapPassword(false);
  }

  function onManualSetup() {
    if (!s.config) return;
    s.setStep(s.config.id === 'exchange' ? 'eas-manual' : 'imap-manual');
  }

  return (
    <div className={shellClass(variant)}>
      {s.step === 'pick' && <ProviderPicker onPick={(id) => s.selectProvider(id)} />}

      {s.step === 'gateway' && s.config && (
        <CredentialsGate
          config={s.config}
          email={s.email} password={s.password}
          advancedClientId={s.advancedClientId} advancedClientSecret={s.advancedClientSecret}
          onChange={(patch) => {
            if (patch.email !== undefined) s.setEmail(patch.email);
            if (patch.password !== undefined) s.setPassword(patch.password);
            if (patch.advancedClientId !== undefined) s.setAdvancedClientId(patch.advancedClientId);
            if (patch.advancedClientSecret !== undefined) s.setAdvancedClientSecret(patch.advancedClientSecret);
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
          values={{ imapHost: s.imapHost, imapPort: s.imapPort, imapSecurity: s.imapSecurity,
            smtpHost: s.smtpHost, smtpPort: s.smtpPort, smtpSecurity: s.smtpSecurity }}
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
          server={s.easServer} deviceId={s.deviceId || newDeviceId()}
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
          onDone={() => {
            // refresh account list + close flow
            useAccountStore.getState().setAccounts.bind(null);
            s.reset();
            onComplete();
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kylins.client.frontend && npx vitest run tests/components/account-setup/AccountSetupFlow.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/components/account-setup/AccountSetupFlow.tsx tests/components/account-setup/AccountSetupFlow.test.tsx
git commit -m "feat(account-setup): add flow root state machine"
```

---

### Task 13: App wiring + type-check

**Files:**
- Modify: `kylins.client.frontend/src/App.tsx`

**Interfaces:**
- Consumes: `AccountSetupFlow`, `getAllAccounts` from `@/services/accounts`, `useAccountStore`.

- [ ] **Step 1: Read current `App.tsx`**

Run: `cat kylins.client.frontend/src/App.tsx` (review the existing init effect that ends by rendering `<AppShell/>`).

- [ ] **Step 2: Add 0-accounts branch + Add-Account modal**

In `src/App.tsx`:
- Add imports:
```ts
import { getAllAccounts } from './services/accounts';
import { useAccountStore } from './stores/accountStore';
import { AccountSetupFlow } from './components/account-setup/AccountSetupFlow';
import { useState } from 'react';
```
- Inside the `init()` effect (after `setReady(true)` but before it, or right after migrations/theme/plugin init), load accounts:
```ts
        const accounts = await getAllAccounts();
        useAccountStore.getState().setAccounts(accounts);
```
- After the `if (!ready)` loading block and the `error` block, before `return <AppShell />;`, add the first-run branch and a modal trigger:
```tsx
  const [adding, setAdding] = useState(false);
  const accounts = useAccountStore((st) => st.accounts);

  if (accounts.length === 0) {
    return (
      <AccountSetupFlow
        variant="fullscreen"
        onComplete={async () => {
          const refreshed = await getAllAccounts();
          useAccountStore.getState().setAccounts(refreshed);
        }}
      />
    );
  }

  return (
    <>
      <AppShell onAddAccount={() => setAdding(true)} />
      {adding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="h-[640px] w-[680px] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] shadow-xl">
            <AccountSetupFlow
              variant="modal"
              onComplete={async () => {
                setAdding(false);
                const refreshed = await getAllAccounts();
                useAccountStore.getState().setAccounts(refreshed);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
```
- If `AppShell` does not accept `onAddAccount`, add an optional prop: in `src/components/layout/AppShell.tsx`, extend its signature to `export function AppShell({ onAddAccount }: { onAddAccount?: () => void } = {})` and wire it to the HeaderBar's "New mail"/add-account button (or add a small button). If wiring into HeaderBar is large, at minimum accept the prop and call it from a new button in AppShell's top bar:
```tsx
{onAddAccount && (
  <button onClick={onAddAccount} className="rounded px-3 py-1 text-sm text-[var(--foreground)]">+ Add account</button>
)}
```

- [ ] **Step 3: Type-check + build**

Run: `cd kylins.client.frontend && npx tsc --noEmit`
Expected: no errors. Fix any strict-mode issues (unused vars, `T | undefined` indexing).

Run: `cd kylins.client.frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Run the full test suite**

Run: `cd kylins.client.frontend && npx vitest run`
Expected: all tests pass (existing + new).

- [ ] **Step 5: Commit**

```bash
cd kylins.client.frontend && git add src/App.tsx src/components/layout/AppShell.tsx
git commit -m "feat(account-setup): wire entry point into App + Add-Account modal"
```

---

## Self-Review

**1. Spec coverage:** Spec §1 (provider table) → Tasks 1, 5. §3 (routing/form factor) → Task 13. §4 (picker) → Task 6. §5 (gateway) → Task 7. §6 (XOAUTH2 flow) → Tasks 5 + 8 + 12. §7 (IMAP/SMTP flow) → Tasks 5 + 9 + 12. §8 (ActiveSync flow) → Tasks 5 + 10 + 12. §9 (common tail) → Task 12. §10 (files) → all. §11 (error handling / encryption) → Tasks 2, 12. §12 (testing) → every task has tests. No spec gaps.

**2. Placeholder scan:** No `TBD`/`TODO`/`implement later`. Bundled `client_id`s are intentionally empty strings with a documented release prerequisite (Global Constraints) — not a plan gap. The `fallbackUrl` placeholder string in `AccountSetupFlow` is a runtime display detail; if you want the real auth URL shown, thread it from `runOAuthFlow` (minor follow-up, not in scope).

**3. Type consistency:** `CreateAccountInput` (from `accounts.ts`) is used by all three builders in Task 5 and consumed in Task 12. `ProviderConfig` union and `OAuthProviderConfig`/`PasswordProviderConfig` are consistent across Tasks 1, 3, 5, 7. `ImapManualValues` exported from Task 9 and used in Task 12. Store field names (`email`, `password`, `advancedClientId`, `imapHost`, `easServer`, `deviceId`) match across Tasks 4 and 12. `runOAuthFlow`'s `{tokens, userInfo}` return matches Task 12's usage.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-account-setup.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
