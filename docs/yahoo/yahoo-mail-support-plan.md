# Yahoo Mail Support & Optimization Plan

> Based on deep research of Yahoo Sender Hub documentation, OAuth2 specs, IMAP/SMTP server settings, 2024+ sender requirements, and reference codebase patterns (inbox-zero, Velo, Kylins).
>
> Sources: https://senders.yahooinc.com/developer/documentation/, https://developer.yahoo.com/oauth2/guide/

## Context

Kylins currently has basic Yahoo Mail support: IMAP/SMTP presets in `providers.ts` (port 993/465), app-password auth flow, and a Yahoo tile in the provider picker. The backend has Yahoo-specific IMAP fixes (parenthesized FETCH queries, persistent sessions to avoid LOGIN rate limits, `\Junk` folder mapping, rate-limit tracking in `db/rate_limit.rs`).

This plan covers the gaps: authentication improvements, deliverability compliance, rate limiting, UI/UX, international variants (AOL, Yahoo Japan), and OAuth2 readiness.

## Yahoo Mail Technical Spec Summary

### Authentication

| Method | Status | Details |
|--------|--------|---------|
| App Password | ✅ Functional, legacy path | Requires 2FA enabled. 16-char code via Yahoo Account Security |
| OAuth2 (Auth Code + PKCE) | 🔒 Restricted | Yahoo no longer allows self-service registration for `mail-r`/`mail-w` scopes. Manual application required. |

**OAuth2 Endpoints:**
| Endpoint | URL |
|----------|-----|
| Authorization | `https://api.login.yahoo.com/oauth2/request_auth` |
| Token | `https://api.login.yahoo.com/oauth2/get_token` |
| Introspection | `https://api.login.yahoo.com/oauth2/introspect` |
| UserInfo | `https://api.login.yahoo.com/openid/v1/userinfo` |
| Revocation | `https://api.login.yahoo.com/oauth2/revoke` |
| OIDC Discovery | `https://api.login.yahoo.com/.well-known/openid-configuration` |

**Scopes:** `mail-r` (read), `mail-w` (write), `email`, `profile`, `openid`

### IMAP/SMTP Server Settings

| Protocol | Server | Port | Encryption |
|----------|--------|------|------------|
| IMAP | `imap.mail.yahoo.com` | 993 | SSL/TLS |
| SMTP | `smtp.mail.yahoo.com` | 465 or 587 | SSL/TLS or STARTTLS |
| POP3 | `pop.mail.yahoo.com` | 995 | SSL |
| **AOL IMAP** | `imap.aol.com` | 993 | SSL/TLS |
| **AOL SMTP** | `smtp.aol.com` | 465 | SSL/TLS |

Username is always the full email address.

### 2024+ Sender Requirements

| Requirement | All Senders | Bulk (5000+/day) |
|-------------|-------------|------------------|
| SPF | SPF or DKIM | SPF + DKIM (both) |
| DKIM | Min 1024-bit | Same |
| DMARC | Strongly recommended | Valid policy, min `p=none` |
| Domain alignment | — | `From:` domain aligns with SPF/DKIM |
| List-Unsubscribe | — | Required, RFC 8058 POST preferred |
| Spam complaint rate | <0.3% | <0.3% |
| PTR record | Valid PTR | Same |
| Max message size | ~25 MB | Same |

### API Availability

Yahoo has **no public REST Mail API**. Only IMAP/SMTP. No equivalent to Gmail API or Microsoft Graph.

### Special-Use Flags

`\Inbox`, `\Sent`, `\Drafts`, `\Trash`, `\Junk` (not `\Spam`), `\Archive`, `\All`

## What Kylins Already Covers

### Frontend
- **Provider config** (`src/services/auth/providers.ts`): `yahooPresets` with IMAP 993, SMTP 465
- **Provider picker** (`ProviderPicker.tsx`): Yahoo tile at position 4
- **Setup UI** (`setup-ui.tsx`): accent color `#6001d2`, custom SVG glyph
- **Credentials gate** (`CredentialsGate.tsx`): app-password hint for password-type providers
- **Theme** (`theme.css`): `--provider-yahoo` light/dark
- **Provider badge** (`ProviderBadge.tsx`): Yahoo label

### Backend (Rust)
1. `imap/client.rs:587` — Parenthesized FETCH query (Yahoo rejects unparenthesized)
2. `imap/client.rs:2785` — Tests enforce parenthesized form
3. `imap/session_manager.rs:362` — Persistent session avoids LOGIN rate-limit hits
4. `sync_engine/commands.rs:123` — Rate-limit error referenced
5. `db/rate_limit.rs` — Full rate-limit tracking table
6. Folder adapter — `roleFromSpecialUse()` handles `\Junk`

### Other
- `db/contacts.rs`: `yahoo.com`, `yahoo.co.uk` domain lists
- `phishingDetector.ts`: `yahoo.com` safe

## Gaps and Optimization Opportunities

### Authentication
| Gap | Severity | Details |
|-----|----------|---------|
| No SMTP port 587 | Medium | Some networks block 465; 587 with STARTTLS is the standard fallback |
| No OAuth2 config | Low-Med | Could extend `OAuthProviderConfig` pattern when client credentials obtained |
| No AOL provider | Low | `@aol.com` users must use manual IMAP setup |
| No Yahoo Japan | Low | Separate infrastructure (Yahoo Japan is independent entity) |
| App-password UX sparse | Low | One sentence + link; no step-by-step guidance |

### Deliverability (Outbound)
| Gap | Severity | Details |
|-----|----------|---------|
| No SPF/DKIM/DMARC guidance | Medium | Custom-domain users get no setup checklist |
| No List-Unsubscribe header | Medium | Yahoo requires it for bulk senders |
| No rate-limit feedback | Low-Med | Generic SMTP failure; `[LIMIT]` response not parsed |
| No SMTP persistent session | Low | Fresh connect each send |

### Rate Limiting & Connections
| Gap | Severity | Details |
|-----|----------|---------|
| Rate-limit detection not specific | Low-Med | `[LIMIT]` tag not parsed for `Retry-After` extraction |
| No connection reuse for SMTP | Low | Each send opens a new SMTP connection |

### UI/UX
| Gap | Severity | Details |
|-----|----------|---------|
| Generic error messages | Low-Med | Yahoo-specific SMTP error codes surfaced as generic |
| No connection test progress | Low | No step-by-step progress indication |

### Testing
| Gap | Severity | Details |
|-----|----------|---------|
| No Yahoo-specific tests | Medium | Config tests exist but no dedicated Yahoo flow tests |

---

## Implementation Plan

### Phase 1: Short-Term Wins (~4 hours)

#### 1.1 Add SMTP Port 587 Alternative
**File:** `kylins.client.frontend/src/services/auth/providers.ts`

- Add `yahooPresetsStarttls` variant: `smtpPort: 587`, `smtpSecurity: 'starttls'`
- Setup flow tries 465 first, falls back to 587 on connection failure
- Update `yahooPresets` to include both port options

#### 1.2 Improve App-Password UX
**Files:**
- `providers.ts` — Richer `appPasswordNote` with numbered step-by-step instructions
- `CredentialsGate.tsx` — Move note above password field, add visual info box with external link icon

#### 1.3 Add AOL as a Provider
**Files:**
- `providers.ts` — Add `aolPresets` (`imap.aol.com:993`, `smtp.aol.com:465`) + config entry + `'aol'` to `SetupProviderId`
- `ProviderPicker.tsx` — Add AOL tile
- `setup-ui.tsx` — AOL accent color + custom SVG glyph
- `theme.css` — `--provider-aol` variables in light/dark
- `ProviderBadge.tsx` — AOL label mapping

#### 1.4 Yahoo-Specific Error Message Mapping
**File:** `kylins.client.frontend/src/services/auth/accountSetupStore.ts`

Map common Yahoo failures to actionable messages:
| Yahoo error | User-facing message |
|-------------|---------------------|
| `LOGIN failed` | "Invalid email or app password. Make sure 2FA is enabled and you're using an app password." |
| Rate limit hit | "Yahoo is temporarily rate-limiting connections. Please wait a few minutes and try again." |
| `AUTHENTICATIONFAILED` | "App password may have expired. Generate a new one in Yahoo Account Security." |
| `[LIMIT]` | "Yahoo has rate-limited connections from this app. Please wait before retrying." |

### Phase 2: Deliverability Compliance (~6 hours)

#### 2.1 Outbound Authentication Guidance
**New files:**
- `kylins.client.frontend/src/services/deliverability.ts` — SPF/DKIM/DMARC guidance module
- `kylins.client.frontend/src/components/settings/DeliverabilityPanel.tsx` — Visual checklist showing SPF/DKIM/DMARC status with links to setup guides per provider

#### 2.2 List-Unsubscribe Header Support
**Files:**
- `kylins.client.frontend/src/services/mail/smtpSender.ts` — Add `List-Unsubscribe` and `List-Unsubscribe-Post` headers to outbound messages
- `kylins.client.backend/src/mail/builder.rs` — Inject headers during MIME assembly

#### 2.3 Rate-Limit Error Detection
**File:** `kylins.client.backend/src/mail/imap/session_manager.rs`

- `classify_error()`: detect `[LIMIT]` tag in response as `ErrorKind::Other` (not `ErrorKind::Auth`) so the engine backsoff instead of retrying auth
- Parse rate-limit window from response text if present

### Phase 3: Advanced (~8 hours)

#### 3.1 Yahoo OAuth2 Configuration Skeleton
**File:** `kylins.client.frontend/src/services/auth/providers.ts`

- Add OAuth2 config for Yahoo with empty `bundledClientId` (users provide own credentials)
- Set up correct endpoints: `https://api.login.yahoo.com/oauth2/request_auth`, `/oauth2/get_token`
- Scopes: `mail-r`, `mail-w`, `openid`, `email`, `profile`
- Redirect URI: `http://localhost:17249` (OAUTH_CALLBACK_PORT)
- Note: `mail-r`/`mail-w` are restricted scopes — user must obtain approval from Yahoo

#### 3.2 Connection Test Progress
**File:** `kylins.client.frontend/src/services/auth/accountSetupFlows.ts`

- Add per-step progress reporting: "Connecting to IMAP...", "Verifying folder access...", "Testing SMTP..."
- Show spinner per step

#### 3.3 Yahoo Japan Provider
**File:** `kylins.client.frontend/src/services/auth/providers.ts`

- Add `yahooJapanPresets` (separate infrastructure: `imap.mail.yahoo.co.jp`, `smtp.mail.yahoo.co.jp`)
- Add to `SetupProviderId` and provider picker

### Phase 4: Testing & Validation (~3 hours)

#### 4.1 Provider Config Tests
**File:** `kylins.client.frontend/tests/services/auth/providers.test.ts`

- Assert Yahoo presets (both 465 and 587)
- Assert AOL presets
- Assert OAuth2 config skeleton (if added)

#### 4.2 Account Setup Flow Tests
**File:** `kylins.client.frontend/tests/services/auth/accountSetupFlows.test.ts`

- Test Yahoo password flow with app-password hint display
- Test AOL flow
- Test error message mapping

#### 4.3 Folder Role Tests
**File:** `kylins.client.frontend/tests/services/mail/folderRoles.test.ts`

- Test `\Junk` → `spam` mapping
- Test Yahoo-specific special-use flags

#### 4.4 Backend Rate-Limit Tests
**File:** `kylins.client.backend/src/mail/imap/client.rs`

- Test `[LIMIT]` response classification
- Test rate-limit backoff behavior

---

## File Modification Summary

### Frontend (TypeScript/TSX)
| File | Phase | Change |
|------|-------|--------|
| `src/services/auth/providers.ts` | P1, P3 | SMTP 587, AOL config, OAuth2 skeleton, Yahoo Japan |
| `src/components/account-setup/ProviderPicker.tsx` | P1 | AOL tile |
| `src/components/account-setup/setup-ui.tsx` | P1 | AOL accent + glyph |
| `src/components/account-setup/CredentialsGate.tsx` | P1 | Better app-password UX |
| `src/styles/theme.css` | P1 | `--provider-aol` |
| `src/components/preferences/ProviderBadge.tsx` | P1 | AOL label |
| `src/services/auth/accountSetupStore.ts` | P1 | Error message mapping |
| `src/services/mail/smtpSender.ts` | P2 | List-Unsubscribe headers |
| `src/services/deliverability.ts` | P2 | SPF/DKIM/DMARC guidance (new) |
| `src/components/settings/DeliverabilityPanel.tsx` | P2 | Checklist UI (new) |
| `src/services/auth/accountSetupFlows.ts` | P3 | Connection test progress |

### Backend (Rust)
| File | Phase | Change |
|------|-------|--------|
| `src/mail/imap/session_manager.rs` | P2 | `[LIMIT]` detection in `classify_error()` |
| `src/mail/builder.rs` | P2 | List-Unsubscribe header injection |

### Tests
| File | Phase | Change |
|------|-------|--------|
| `tests/services/auth/providers.test.ts` | P4 | Yahoo/AOL assertions |
| `tests/services/auth/accountSetupFlows.test.ts` | P4 | Yahoo flow tests |
| `tests/services/mail/folderRoles.test.ts` | P4 | `\Junk` mapping test |
| `backend/src/mail/imap/client.rs` | P4 | `[LIMIT]` detection test |

---

## External Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| OAuth2 scopes restricted (`mail-r`/`mail-w` require manual approval) | App-password remains primary; OAuth2 is opt-in for users with approved client IDs |
| Yahoo Japan is separate entity | Treat as distinct provider with different endpoints |
| AOL/Verizon/AT&T share Yahoo infrastructure | Same IMAP/SMTP pattern works; separate `SetupProviderId` for UX |
| App-password deprecation risk | Monitor Yahoo announcements; OAuth2 skeleton ready |
| Rate-limit thresholds undocumented | Conservative backoff; `[LIMIT]` response parsing for dynamic windows |
| Policy changes without notice | Subscribe to sender-hub updates; keep app-password guidance current |
