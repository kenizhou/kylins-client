# Account Creation — Entry Point & Flows Design

> Spec for the kylins mail client (Tauri v2 + React 19 + Rust).
> Date: 2026-06-23. Informed by Velo (port baseline), Mailspring (OAuth-browser UX + Yahoo app-password), mailkit_arkts (unified email-gateway screen, EAS pre-check), and the kylins OAuth2 comparison report.

## 1. Goal

An entry point that lets a user add a mail account for any of:

| Provider tile | Method | Stored as |
|---|---|---|
| Gmail | XOAUTH2 | `provider:'imap'`, `authMethod:'oauth2'`, `oauthProvider:'google'` |
| Outlook (personal) | XOAUTH2 | `provider:'imap'`, `authMethod:'oauth2'`, `oauthProvider:'microsoft'` |
| Microsoft 365 | XOAUTH2 | `provider:'imap'`, `authMethod:'oauth2'`, `oauthProvider:'microsoft'` |
| Yahoo | app-password (IMAP/SMTP) | `provider:'imap'`, `authMethod:'password'` |
| Other (IMAP/SMTP) | password (manual) | `provider:'imap'`, `authMethod:'password'` |
| Exchange (local) | ActiveSync | `provider:'eas'` |

All OAuth providers use IMAP+XOAUTH2 (not the Gmail REST API, not Graph). Microsoft OAuth uses `outlook.office.com/IMAP|SMTP` scopes — these cannot call Graph, so userinfo comes from the `id_token` JWT.

## 2. Decision Log

| Decision | Choice | Why |
|---|---|---|
| OAuth client identity | **Hybrid**: bundle public `client_id` (PKCE, no secret) per provider + Advanced screen for user-supplied `client_id` | One-click by default; power-user escape hatch |
| Form factor | **A**: first-run full-screen route + later modal | `App.tsx` renders full-window setup when `accounts.length===0`; same component opens as modal for "Add Account" |
| XOAUTH2 capture | **System browser + Rust loopback** (already built: `oauth.rs` + `oauth.ts`) | Officially recommended by Google/MS for desktop; already implemented + tested |
| Yahoo | **app-password** IMAP/SMTP | Yahoo OAuth is increasingly restricted; matches Mailspring reference |
| Security | **PKCE + public clients, no embedded secrets** | mailkit/Mailspring embed secrets in source — kylins avoids this |
| Gateway screen | **Unified email-gateway** (mailkit pattern) | Email always; password only for PLAIN providers; fewer components |

**Prerequisite (bundled clients):** the hybrid model requires registering one **public** OAuth app per provider (Google "Desktop app", Azure "Mobile and desktop applications" platform) and bundling only the `client_id` (no secret, PKCE-only). Each app must have `http://127.0.0.1:17249` registered as an allowed redirect URI. Until these are registered, the Advanced override lets a user supply their own `client_id` to test the flow.

## 3. Routing & Form Factor (Approach A)

`App.tsx` already conditionally renders loading/error/`<AppShell/>`. Add one branch keyed on account count:

```
App.tsx
  loading            → "Loading your inbox…"
  error              → reload screen
  accounts.length===0 → <AccountSetupFlow variant="fullscreen"/>   // no AppShell yet
  else               → <AppShell/>                                  // "Add Account" opens
                                                       // <AccountSetupFlow variant="modal"/>
```

The **same** `<AccountSetupFlow>` is reused in both shells; `variant` only changes chrome (full window vs centered card + backdrop). The flow is a state machine in a new Zustand `accountSetupStore`:

```
idle → pick → gateway → (oauth-pending | imap-manual | eas-manual | verifying)
                                        │
                                        ▼
                                  verifying → success → (welcome | done)
                                            ↘ error → retry/back
```

`step` drives which sub-screen renders; `Back` pops the previous step; `error` is shown inline with Retry.

## 4. Entry Screen — Provider Picker

Desktop Outlook-style tile grid (not mailkit's list):

```
+----------------------------------------------------+
|                   Add an account                    |
|   +--------+  +--------+  +--------+  +--------+   |
|   | Gmail  |  |Outlook |  |  M365  |  | Yahoo  |   |
|   +--------+  +--------+  +--------+  +--------+   |
|   +-----------------+    +----------------------+  |
|   | Other (IMAP/SMTP)|    | Exchange (ActiveSync)| |
|   +-----------------+    +----------------------+  |
+----------------------------------------------------+
```

Each `<ProviderButton>` carries a `providerId` that resolves to a config in **`src/services/auth/providers.ts`** (the provider-config layer missing today). Each config holds: `authType` (`'oauth2' | 'password'`), IMAP/SMTP presets, and (for OAuth) endpoints/scopes/extras.

## 5. Unified Email-Gateway Screen (mailkit pattern)

ONE shared screen after any tile, adapted to `authType`:

```
   ┌──────────────────────────────────────┐
   │ [logo]  Add your <Provider> account   │
   │                                       │
   │ Email:    [_____________________]     │   ← always shown
   │ Password: [_____________________]     │   ← only when authType === 'password'
   │                                       │
   │ ▸ Advanced (OAuth client_id/secret)   │   ← only for oauth2 providers (hybrid override)
   │                                       │
   │ Manual setup            [Sign in ▶]   │   ← escape hatch + primary action
   └──────────────────────────────────────┘
```

- **Email** validated (basic SMTP shape); drives `login_hint` for OAuth and the account identity.
- **Password** visible only for `password` providers (Yahoo / Other / Exchange). Hidden for OAuth providers.
- **Advanced** disclosure (OAuth providers only): optional `client_id` / `client_secret` fields. Blank → use the bundled public client.
- **Submit gating** uses a bitmask `requiredFields` validator (mailkit's `FieldValidFlag` pattern): OAuth needs email; PLAIN needs email+password.
- **"Sign in" action** branches by provider:
  - OAuth → `oauth-pending`
  - PLAIN with presets (Yahoo) → `verifying` (create directly)
  - Exchange → `verifying` (create EAS directly)
- **"Manual setup"** escape → `imap-manual` (IMAP/Other) or `eas-manual` (Exchange).

## 6. Flow A — XOAUTH2 (Gmail / Outlook / M365)

Provider config (`providers.ts`):
```
google:     auth  accounts.google.com/o/oauth2/v2/auth
            token oauth2.googleapis.com/token
            userinfo googleapis.com/oauth2/v2/userinfo
            scopes: gmail.readonly, gmail.modify, gmail.send, gmail.labels,
                    userinfo.email, userinfo.profile
            extras: access_type=offline, prompt=consent
            presets: imap.gmail.com:993/SSL · smtp.gmail.com:587/STARTTLS
microsoft:  auth/token login.microsoftonline.com/common/oauth2/v2.0/*
            scopes: outlook.office.com/IMAP.AccessAsUser.All, SMTP.Send,
                    offline_access, openid, profile, email
            presets: outlook.office365.com:993/SSL · smtp.office365.com:587/STARTTLS
            (userinfo from id_token JWT — these scopes can't call Graph)
```

Steps:
1. Resolve provider config + `clientId` (bundled or Advanced override) + `clientSecret?`.
2. **PKCE + state**: `generateCodeVerifier()` / `generateCodeChallenge()` / `generateState()` (`oauth.ts:47-64`).
3. **Start loopback**: `startOAuthServer(port, state)` (`oauth.rs:19`); returns bound port (tries port..port+3).
4. **Open system browser** via Tauri **opener** with auth URL (`client_id, redirect_uri=http://127.0.0.1:{port}, response_type=code, scope, code_challenge=S256, state`, + Google `access_type`/`prompt`, `login_hint=email`). Default `port = 17249` (configurable; must be registered as an allowed loopback redirect URI with each provider's OAuth console). *(Adds npm dep `@tauri-apps/plugin-opener`; Rust side already present.)*
5. **OAuth-pending screen**: provider logo + "Sign in with [Provider] in your browser" + fallback URL field + copy button + spinner. `start_oauth_server` awaits the redirect (5-min timeout, `oauth.rs:40`).
6. **Callback**: IdP redirects → Rust validates `state` (`oauth.rs:57`), returns `code`. On `error=` or state mismatch → error screen + Retry.
7. **Exchange**: `exchangeToken({tokenUrl, code, clientId, redirectUri, codeVerifier, clientSecret?})` (`oauth.ts:11`) → `{access_token, refresh_token, expires_in, id_token}`.
8. **Userinfo**: Google → GET userinfo endpoint; Microsoft → **decode `id_token` JWT**. Populate `email`, `displayName`, `avatarUrl`.
9. **Verify**: IMAP connect + XOAUTH2 auth (`mail/imap/client.rs`) against the preset host.
10. **Save**: `encryptSecret()` tokens + optional secret (`crypto.ts`); `createAccount({ provider:'imap', authMethod:'oauth2', oauthProvider, oauthClientId, accessToken, refreshToken, tokenExpiresAt, imapHost/Port/Security, smtpHost/Port/Security })`.
11. → Common tail (§9).

## 7. Flow B — IMAP / SMTP (Yahoo / Other / manual)

Result: `provider:'imap'`, `authMethod:'password'`.

1. Gateway collects email + password (Yahoo tile shows app-password note + "create one" link).
2. **Autodiscover presets** from email domain (well-known map: gmail/outlook/yahoo/icloud/fastmail/126/163…). Yahoo pre-fills `imap.mail.yahoo.com:993` / `smtp.mail.yahoo.com:465`.
3. Default path ("Sign in"): create directly with presets → verifying.
4. **Manual setup** path → `imap-manual` screen: username, password, IMAP server/port/security, SMTP server/port/security (editable; bitmask-gated submit).

```
   ┌─ Incoming (IMAP) ────────┐   ┌─ Outgoing (SMTP) ────────┐
   │ Server [imap.gmail.com]  │   │ Server [smtp.gmail.com]  │
   │ Port   [993]             │   │ Port   [587] /465        │
   │ Security [SSL/TLS ▾]     │   │ Security [STARTTLS ▾]    │
   │ Username [= email]       │   │ Username [= email]       │
   └──────────────────────────┘   └──────────────────────────┘
                   [Test connection] → ✓ IMAP · ✓ SMTP
```

5. **Verify**: `test_connection` for IMAP (Rust) and SMTP.
6. **Save**: `encryptSecret(imapPassword)`; `createAccount({ provider:'imap', authMethod:'password', imapHost/Port/Security, smtpHost/Port/Security, imapUsername, imapPassword })`. → Common tail.

## 8. Flow C — ActiveSync (local Exchange)

Uses kylins's EAS backend (`eas/client.rs`, `eas/commands.rs`, `eas/service.rs`, WBXML, `easProvider.ts`). Result: `provider:'eas'`.

1. Gateway collects email + password (+ optional Server URL; blank = Autodiscover).
2. `eas-manual` screen (escape hatch): email, password, username, server, port, security; shows the **`deviceId`** (mailkit pattern, `account_setup_exchange_manually.ets:289-292`).
3. **Pre-check** server reachability (mailkit `NetworkUtil.isRemoteHostAvailable` pattern) before connecting.
4. Generate/persist `easDeviceId` (stable per install), `easProtocolVersion='16.1'`, `easUserAgent`.
5. **Resolve server**: blank → EAS Autodiscover (POX/JSON) from email; else use given URL → `easUrl`.
6. **Provision**: EAS `Provision` → negotiate policy → store `easPolicyKey`.
7. **Verify**: EAS `Settings` + `FolderSync` to confirm creds + fetch folders. Show connecting overlay during this.
8. **Save**: `encryptSecret(password)`; `createAccount({ provider:'eas', easUrl, easDeviceId, easProtocolVersion, easPolicyKey, easUserAgent })`. → Common tail.

## 9. Common Tail — verify → save → success

```
verifying (spinner + per-check: "Connecting… ✓ Auth… ✓ Folders…")
   │ success
   ▼
save (encrypt secrets → createAccount → refresh accountStore)
   │
   ├─ first account → <WelcomeScreen/>  (reading-pane pref + shortcut set; mirrors welcome.png)
   └─ else           → close modal; account appears in switcher
```
After Welcome → render `<AppShell/>` (first account becomes `activeAccountId`).

## 10. Files & Component Tree

```
src/
├─ App.tsx                       (modify: 0-accounts branch + Add-Account modal trigger)
├─ services/
│  ├─ auth/
│  │  ├─ providers.ts            (NEW — Gmail/Outlook/M365/Yahoo/IMAP/Exchange configs + presets)
│  │  ├─ oauth.ts                (exists)
│  │  ├─ accountSetupFlows.ts    (NEW — runOAuthFlow / testImap / testEas orchestrators)
│  │  └─ userInfo.ts             (NEW — Google userinfo + MS id_token JWT decode)
│  └─ accounts.ts                (modify — encrypt tokens/pw at write boundary)
├─ stores/
│  └─ accountSetupStore.ts       (NEW — wizard state machine + bitmask validation)
└─ components/
   └─ account-setup/
      ├─ AccountSetupFlow.tsx    (root: variant fullscreen|modal; step router)
      ├─ ProviderPicker.tsx
      ├─ ProviderButton.tsx
      ├─ CredentialsGate.tsx     (unified email + conditional password + Advanced)
      ├─ OAuthPendingScreen.tsx
      ├─ ImapManualForm.tsx
      ├─ EasManualForm.tsx
      ├─ VerifyStep.tsx
      └─ WelcomeScreen.tsx
```

## 11. Error Handling

- **OAuth**: state mismatch / 5-min timeout / exchange failure → error screen + Retry (restarts flow). Port-bind handled by existing port+3 fallback (`oauth.rs:21`).
- **IMAP/SMTP & EAS**: per-server auth failures shown inline on the settings screen; save is blocked until a test passes.
- **EAS host unreachable**: pre-check surfaces "cannot reach server" before attempting auth.
- **Encryption**: all secrets pass through `encryptSecret` at the `accounts.ts` write boundary (closes the plaintext-storage gap flagged in the OAuth report).

## 12. Testing

- `accountSetupStore` state transitions + bitmask validation.
- `providers.ts` config shape per provider.
- `accountSetupFlows` with `invoke` mocked (pattern from existing `crypto.test.ts`).
- `userInfo` JWT decode + Google userinfo parsing.
- Form component tests (Testing Library): conditional password visibility, submit-gating, Advanced disclosure.

## 13. Out of Scope (deferred)

- Gmail REST API provider (`gmail_api`) and Microsoft Graph provider — current scope is IMAP+XOAUTH2 / EAS only.
- Token refresh lifecycle manager (proactive refresh + mutex) — separate spec; referenced in the OAuth report.
- Mailspring-style MX/domain auto-discovery probe for unknown IMAP domains — v1 leaves servers editable.
- Plugin-injected provider tiles — the picker is static for now; plugin extension is a later concern.
