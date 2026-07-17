# Crypto Phase 1b Plan 4 — S/MIME Receive Frontend (G6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the React frontend to the G5 backend so that opening an encrypted/signed message decrypts + verifies it (via `crypto_open_message`), renders the decrypted plaintext, surfaces the full trust taxonomy (granular CryptoBadge), offers a TrustDialog to accept/reject unverified signers, shows a decrypt-failure panel, and lets the user manage trusted CA roots — all with plaintext held in a session cache (never re-fetched per open).

**Architecture:** This is **Phase 1b Plan 4 (G6)**, frontend-only (`kylins.client.frontend/`). It consumes the G5 backend: `crypto_open_message(accountId, messageId) -> OpenCryptoResult`, `db_get_message_crypto_result`, the `sync:crypto-result` event, `db_put_trust_decision` / `db_get_trust_decision`, and `db_upsert_crypto_key` (for CA-root import). Plaintext comes from `OpenCryptoResult.plaintextHtml` (in-memory); it is cached in a session `Map` in `viewStore`, never written to disk. The plan extends the existing `SecurityChips` into a granular `CryptoBadge`, hoists it past the reading-pane's classification gate, and adds a TrustDialog + a "Trusted CAs" KeyManager section.

**Tech Stack:** React 19 + TypeScript + Vite; Zustand stores; `@tauri-apps/api` invoke + `@tauri-apps/api/event` listen; react-aria-components (RAC) for the TrustDialog modal; Tailwind v4 + CSS-var tokens. Tests: Vitest 4 + jsdom + Testing Library (`globals: true` — no need to import describe/it/expect). Spec: `docs/superpowers/specs/2026-07-12-crypto-phase1b-smime-receive-design.md` §7.

## Global Constraints

- **User controls git — DO NOT COMMIT.** Skip "Commit" steps; leave changes uncommitted. Controller review still runs per task.
- **SDD workflow:** fresh implementer subagent per task + controller review + ledger entry.
- **Gates (every task):** `npx tsc --noEmit` clean; `npx vitest run` green (relevant tests); `npx eslint <changed files>` clean. Run from `kylins.client.frontend/`. (The project's `npm run build` = tsc + vite; `npm run test` = vitest in watch — use `npx vitest run` for one-shot.)
- **Frontend-only.** Do NOT touch Rust (G5 backend is committed at `8826781`). If a backend command/signature is missing, flag it — do not edit Rust in this plan.
- **TypeScript strictness:** `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` are on. Indexing arrays → `T | undefined`.
- **Path alias:** `@/*` → `src/*`. Prefer `@/` imports.
- **Plaintext is memory-only:** decrypted plaintext lives in the `viewStore` session cache + the `MailMessage.html` (in-memory React state); it is NEVER written to SQLite. Only `message_crypto_results` is persisted (by the backend).
- **Serde caveat (critical):** `OpenCryptoResult` + `ImapAttachment` serialize SNAKE_CASE (no `rename_all` on those Rust structs); `MessageCryptoResultRow` + `CryptoResultEvent` serialize CAMELCASE. The TS types must mirror this EXACTLY or IPC deserialization silently yields `undefined`.

## File Structure

**Create:**
- `src/services/db/cryptoReceive.ts` — `openCryptoMessage`, `getMessageCryptoResult`, `putTrustDecision`, `getTrustDecision` wrappers + the `MessageCryptoResult` / `OpenCryptoResult` / `TrustDecision` TS types.
- `src/features/view/CryptoBadge.tsx` — the granular badge (extends SecurityChips' role; full SignatureState/DecryptState taxonomy).
- `src/components/email/TrustDialog.tsx` — the accept/reject-signer modal (model on `LinkConfirmDialog.tsx`).
- `src/components/preferences/TrustedCasSection.tsx` — the "Trusted CAs" KeyManager subsection (model on `KeyManagerSection.tsx`).

**Modify:**
- `src/features/view/viewStore.ts` — extend `MailMessage` with crypto-result fields; add the session plaintext cache (`Map<messageId, DecryptedContent>`).
- `src/stores/threadStore.ts` — `selectThread` crypto branch (invoke `crypto_open_message` for crypto-marked messages).
- `src/components/layout/ReadingPane.tsx` — hoist crypto badge past the classification gate; decrypt-failure panel (render instead of `EmailRenderer`); mount `TrustDialog` on ValidUnverified/UnknownKey/Mismatch.
- `src/components/layout/ribbon/ReadRibbon.tsx` — hoist crypto badge past the classification gate (mirror ReadingPane).
- `src/features/classification/components/SecurityChips.tsx` — keep as the simple boolean list-row variant; the granular CryptoBadge is the reading-pane/ribbon variant. (Or extend SecurityChips to accept an optional `cryptoResult` — implementer's call, but keep the list-row boolean path intact.)
- `src/components/preferences/SecurityPreferences.tsx` — mount `<TrustedCasSection />` next to `<KeyManagerSection />`.
- `src/hooks/useSyncEvents.ts` — add the `sync:crypto-result` listener.

---

## Interfaces (cross-task contract — implementers read this)

- **`MessageCryptoResult`** (TS, Task 1) — mirrors Rust `MessageCryptoResultRow` (CAMELCASE): `{ accountId, messageId, cryptoKind: 'encrypted'|'signed'|'encrypted-signed', decryptState: 'ok'|'no-key'|'failed'|'n/a', signatureState: 'not-signed'|'valid-verified'|'valid-unverified'|'invalid'|'unknown-key'|'mismatch', signerFingerprint?: string|null, signerEmail?: string|null, chainValid?: number|null, revocationState: 'good'|'revoked'|'unchecked', verifiedAt: string }`.
- **`OpenCryptoResult`** (TS, Task 1) — mirrors Rust `OpenCryptoResult` (**SNAKE_CASE**): `{ plaintext_html: string|null, plaintext_text: string|null, attachments: ImapAttachment[], crypto_result: MessageCryptoResult }`.
- **`MailMessage`** (Task 1 extends) — add: `signatureState?: MessageCryptoResult['signatureState']`, `decryptState?: MessageCryptoResult['decryptState']`, `signerEmail?: string|null`, `signerFingerprint?: string|null`, `revocationState?: MessageCryptoResult['revocationState']`.
- **`openCryptoMessage(accountId, messageId): Promise<OpenCryptoResult>`** + **`getMessageCryptoResult(accountId, messageId): Promise<MessageCryptoResult|null>`** + **`putTrustDecision(input): Promise<void>`** + **`getTrustDecision(accountId, peerEmail, standard, fingerprint): Promise<TrustDecision|null>`** (Task 1, in `cryptoReceive.ts`).

---

## Task 1: Services + types + MailMessage shape

**Files:**
- Create: `src/services/db/cryptoReceive.ts`
- Modify: `src/features/view/viewStore.ts` (MailMessage + session cache)

**Interfaces:** produces the types + wrappers above (consumed by Tasks 2-7).

- [ ] **Step 1: Write the service + types**

Create `src/services/db/cryptoReceive.ts`:
```ts
import { invoke } from '@tauri-apps/api/core';

/** Mirrors Rust `MessageCryptoResultRow` (CAMELCASE on the wire). */
export interface MessageCryptoResult {
  accountId: string;
  messageId: string;
  cryptoKind: 'encrypted' | 'signed' | 'encrypted-signed';
  decryptState: 'ok' | 'no-key' | 'failed' | 'n/a';
  signatureState: 'not-signed' | 'valid-verified' | 'valid-unverified' | 'invalid' | 'unknown-key' | 'mismatch';
  signerFingerprint?: string | null;
  signerEmail?: string | null;
  chainValid?: number | null;
  revocationState: 'good' | 'revoked' | 'unchecked';
  verifiedAt: string;
}

/** Mirrors Rust `ImapAttachment` (SNAKE_CASE on the wire — no rename_all). */
export interface ImapAttachment {
  part_id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id?: string | null;
  is_inline: boolean;
}

/** Mirrors Rust `OpenCryptoResult` (SNAKE_CASE on the wire — no rename_all on the
 *  outer struct; the nested crypto_result IS MessageCryptoResult (camelCase)). */
export interface OpenCryptoResult {
  plaintext_html: string | null;
  plaintext_text: string | null;
  attachments: ImapAttachment[];
  crypto_result: MessageCryptoResult;
}

/** Mirrors Rust `TrustDecisionInput` (CAMELCASE) + `TrustDecisionRow`. */
export interface TrustDecisionInput {
  accountId: string;
  peerEmail: string;
  standard: 'smime';
  fingerprint: string;
  decision: 'rejected' | 'undecided' | 'unverified' | 'verified' | 'personal';
  evidenceJson?: string | null;
}
export interface TrustDecision {
  id: number;
  accountId: string;
  peerEmail: string;
  standard: string;
  fingerprint: string;
  decision: string;
  evidenceJson?: string | null;
  decidedAt: string;
}

export async function openCryptoMessage(accountId: string, messageId: string): Promise<OpenCryptoResult> {
  return invoke<OpenCryptoResult>('crypto_open_message', { accountId, messageId });
}

export async function getMessageCryptoResult(accountId: string, messageId: string): Promise<MessageCryptoResult | null> {
  return invoke<MessageCryptoResult | null>('db_get_message_crypto_result', { accountId, messageId });
}

export async function putTrustDecision(input: TrustDecisionInput): Promise<void> {
  await invoke('db_put_trust_decision', { input });
}

export async function getTrustDecision(
  accountId: string, peerEmail: string, standard: string, fingerprint: string,
): Promise<TrustDecision | null> {
  return invoke<TrustDecision | null>('db_get_trust_decision', { accountId, peerEmail, standard, fingerprint });
}
```
(Confirm the exact `db_put_trust_decision` / `db_get_trust_decision` arg shapes by reading `kylins.client.backend/src/db/commands.rs` (~L1157) — the Rust `TrustDecisionInput` is camelCase + taken as a single `input` arg; `db_get_trust_decision` takes the 4 fields. Match the invoke arg names to the Rust `#[tauri::command]` param names exactly.)

- [ ] **Step 2: Extend `MailMessage` + add the session plaintext cache**

In `src/features/view/viewStore.ts`, extend the `MailMessage` interface with the optional crypto-result fields (signatureState, decryptState, signerEmail, signerFingerprint, revocationState — all optional so non-crypto messages are unaffected). Add a session plaintext cache to the store:
```ts
// in the viewStore state shape:
decryptedCache: Record<string, { html: string | null; text: string | null }>;  // keyed by messageId
setDecrypted: (messageId: string, html: string | null, text: string | null) => void;
clearDecrypted: () => void;
```
(`clearDecrypted` is called on lock/logout — wire to the existing lock-logout hook if one exists, otherwise just expose it.)

- [ ] **Step 3: Test**

A vitest test (`cryptoReceive.test.ts`) mocking `@tauri-apps/api/core` `invoke` (mirror the existing `send.test.ts` / `cryptoKeys.test.ts` mock pattern) — assert `openCryptoMessage` invokes `crypto_open_message` with the right args + returns the typed result; `putTrustDecision` invokes with the camelCase input. The test pins the SNAKE_CASE `OpenCryptoResult` contract (assert `plaintext_html` not `plaintextHtml`).

Run: `cd kylins.client.frontend && npx vitest run src/services/db/cryptoReceive.test.ts && npx tsc --noEmit`
Expected: PASS + tsc clean.

- [ ] **Step 4: Commit (SKIPPED — user controls git)**

---

## Task 2: Granular CryptoBadge

**Files:**
- Create: `src/features/view/CryptoBadge.tsx`
- (Optionally extend `SecurityChips.tsx` — see note.)

**Interfaces:** consumes `MessageCryptoResult['signatureState']` + `decryptState`.

- [ ] **Step 1: Write the CryptoBadge component**

Create `src/features/view/CryptoBadge.tsx` — a label-variant badge rendering the full taxonomy (spec §7 + the spec's SignatureState table):
- **Decrypt:** lock glyph — solid when `decryptState=ok`, broken/crossed when `no-key`/`failed`, absent when `n/a`/not-encrypted.
- **Signature:** ✓ `valid-verified`, ◐ `valid-unverified`, ? `unknown-key`, ⚠ `mismatch`, ✕ `invalid`, absent `not-signed`.
- **Revocation overlay:** a small warning glyph when `revocationState=unchecked`/`revoked`.
- **Tooltip** (title attr) with signer email + fingerprint + chain/revocation detail.
- `variant: 'icon' | 'label'` (icon for compact list rows once Thread carries the state; label for reading pane).

Use the existing CSS-var tokens + the `useSecurityIndicatorIcons` pluggable icon source where it fits; otherwise inline SVGs matching the existing glyph style. Keep it deterministic + accessible (title/aria-label).

- [ ] **Step 2: Test**

A vitest + Testing Library test rendering `<CryptoBadge>` for each state + asserting the right glyph/label appears (e.g. `valid-verified` → the ✓ + "Verified" label; `no-key` → the broken-lock + "No key"). Mirror the existing `KeyManager.test.tsx` / `SecurityChips` test pattern.

Run: `npx vitest run src/features/view/CryptoBadge.test.tsx && npx tsc --noEmit`

- [ ] **Step 3: Commit (SKIPPED)**

---

## Task 3: `threadStore.selectThread` crypto wiring + session plaintext cache

**Files:**
- Modify: `src/stores/threadStore.ts` (`selectThread` L108-151)

**Interfaces:** consumes `openCryptoMessage` + `setDecrypted` (Task 1); produces the wired open flow (consumed by Task 4's ReadingPane via viewStore.selectedMessage).

- [ ] **Step 1: Add the crypto branch to `selectThread`**

In `selectThread`, after `const latest = messages[messages.length - 1] ?? null;` + the `if (latest)` guard, branch on `latest.is_encrypted === 1 || latest.is_signed === 1`:
- **Crypto path:** check the session `decryptedCache` first (cache hit → use cached html/text). On miss: `const result = await openCryptoMessage(thread.accountId, latest.id);` → `setDecrypted(latest.id, result.plaintext_html, result.plaintext_text);` → build the `MailMessage` from `latest` + `result.plaintext_html` + the `result.crypto_result` fields (signatureState, decryptState, signerEmail, signerFingerprint, revocationState) → `setSelectedMessage(...)`.
- **Plain path (unchanged):** the existing `getMessageBody` + cache-miss `sync_request_bodies` flow for non-crypto messages.

Wrap the crypto invoke in try/catch — on error, set the MailMessage with `decryptState: 'failed'` + a toast (`useToastStore.push('Decrypt failed: …', 'error')`) so the ReadingPane shows the decrypt-failure panel (Task 4). Do NOT crash the open flow.

- [ ] **Step 2: Test**

A vitest test for `selectThread` mocking `getMessagesForThread` + `openCryptoMessage` + `getMessageBody` + the invoke mock — assert that an encrypted message triggers `openCrypto_message` (not `sync_request_bodies`) + that `selectedMessage` carries the crypto_result fields + the plaintext from `plaintext_html`. Assert the session cache is hit on a second open (no second invoke). Mirror the existing `threadStore` test patterns.

Run: `npx vitest run src/stores/threadStore.test.ts && npx tsc --noEmit`

- [ ] **Step 3: Commit (SKIPPED)**

---

## Task 4: ReadingPane integration (hoist gate + decrypt-failure panel + badge)

**Files:**
- Modify: `src/components/layout/ReadingPane.tsx` (L196-211 badge gate; L246-281 body region)
- Modify: `src/components/layout/ribbon/ReadRibbon.tsx` (L455-476 — mirror the gate hoist)

**Interfaces:** consumes the wired `selectedMessage` (crypto-result fields) from Task 3 + `CryptoBadge` (Task 2).

- [ ] **Step 1: Hoist the crypto badge past the classification gate**

In `ReadingPane.tsx`, the crypto badge is currently inside `{level && (...)}` (L196-211). Hoist a crypto badge OUT of that gate so encrypted/signed mail shows its badge even without a classification level. Render `<CryptoBadge signatureState={message.signatureState} decryptState={message.decryptState} ... variant="label" />` whenever `message.isEncrypted || message.isSigned` (independent of `level`). Keep the `ClassificationBadge` inside its own `level &&` gate. Do the same in `ReadRibbon.tsx`.

- [ ] **Step 2: Decrypt-failure panel**

In the `<main>` body region (L246-281), gate the `<EmailRenderer>` (and `<AttachmentList>`) on `message.decryptState !== 'no-key' && message.decryptState !== 'failed'`. When it IS no-key/failed, render a centered status panel instead (model on the empty-state branch L141-159): "Can't decrypt — no matching private key" for `no-key`, "Decryption failed: …" for `failed`, + a "Manage keys" action (links to Security preferences). For `ok`/`n/a`/undefined → the normal EmailRenderer with `message.html` (the decrypted plaintext for crypto mail).

- [ ] **Step 3: Test**

A vitest + Testing Library test rendering `<ReadingPane>` (mocked viewStore) with a decrypted message (`decryptState=ok`, html set) → EmailRenderer renders; with `decryptState=no-key` → the decrypt-failure panel renders, EmailRenderer does not. Mirror existing ReadingPane test patterns (if none exist, test the conditional rendering logic directly).

Run: `npx vitest run src/components/layout/ReadingPane.test.tsx && npx tsc --noEmit`

- [ ] **Step 4: Commit (SKIPPED)**

---

## Task 5: TrustDialog

**Files:**
- Create: `src/components/email/TrustDialog.tsx`
- Modify: `src/components/layout/ReadingPane.tsx` (mount TrustDialog on ValidUnverified/UnknownKey/Mismatch)

**Interfaces:** consumes `putTrustDecision` (Task 1); on "Trust signer" → re-`openCryptoMessage` → `ValidVerified`.

- [ ] **Step 1: Write the TrustDialog component**

Create `src/components/email/TrustDialog.tsx`, modeled on `src/components/email/LinkConfirmDialog.tsx` (RAC `ModalOverlay`/`Modal`/`Dialog`, self-contained, Cancel/primary-action pair). Props: `{ accountId, messageId, signerEmail, signerFingerprint, chainInfo, onResolved, onCancel }`. Actions:
- **Trust signer** → `putTrustDecision({ accountId, peerEmail: signerEmail, standard: 'smime', fingerprint: signerFingerprint, decision: 'verified' })` → `onResolved()` (the caller re-opens → `ValidVerified`).
- **Trust & save cert** → same trust decision + (optionally) stage the signer cert (defer if no cert-staging command is wired; the trust decision alone flips ValidUnverified→ValidVerified on re-open).
- **Don't trust** → `putTrustDecision({ ..., decision: 'rejected' })` → `onCancel()`.
Show signer identity (email, fingerprint, issuer/chain status). Toasts on success/error.

- [ ] **Step 2: Mount it in ReadingPane**

In `ReadingPane.tsx`, track a `pendingTrust` state (the signer info) set when `message.signatureState` is `valid-unverified` | `unknown-key` | `mismatch`. Render `{pendingTrust && <TrustDialog ... onResolved={() => { setPendingTrust(null); reOpen(); }} />}` where `reOpen` re-invokes `openCryptoMessage` (or re-reads via `getMessageCryptoResult`) to refresh `selectedMessage` to `valid-verified`.

- [ ] **Step 3: Test**

A vitest + Testing Library test for TrustDialog: render with signer info → "Trust signer" calls `putTrustDecision` with `decision: 'verified'` + the right fingerprint, then `onResolved`. "Don't trust" → `decision: 'rejected'`. Mock `invoke`. Mirror `LinkConfirmDialog` test patterns (if any) or test the action handlers directly.

Run: `npx vitest run src/components/email/TrustDialog.test.tsx && npx tsc --noEmit`

- [ ] **Step 4: Commit (SKIPPED)**

---

## Task 6: KeyManager "Trusted CAs" + `sync:crypto-result` listener

**Files:**
- Create: `src/components/preferences/TrustedCasSection.tsx`
- Modify: `src/components/preferences/SecurityPreferences.tsx` (mount `<TrustedCasSection />` next to `<KeyManagerSection />` at L300)
- Modify: `src/hooks/useSyncEvents.ts` (add `sync:crypto-result` listener)

**Interfaces:** consumes `db_upsert_crypto_key` (via a wrapper) for CA import + `getMessageCryptoResult` (Task 1).

- [ ] **Step 1: `TrustedCasSection` component**

Create `src/components/preferences/TrustedCasSection.tsx`, modeled on `KeyManagerSection.tsx` (master/detail in a `PreferencesSectionCard`, account picker, Import PEM button, a `<ul>` list with per-row Delete). Import a CA-root PEM file (via the existing `crypto_import_key_from_path` if it accepts cert-only, OR `db_upsert_crypto_key` with `key_type='cert'` — read the backend to pick the route; the G6 grounding found NO frontend `upsertCryptoKey` wrapper, so add one to `cryptoReceive.ts` or `cryptoKeys.ts`). List CA roots via the existing `listCryptoKeysForAccount` filtered to `keyType === 'cert'` (or a new `listTrustAnchors` wrapper around a backend command — check if one exists; G5's `list_trust_anchor_certs` is NOT a Tauri command, so filter client-side via `listCryptoKeysForAccount`). Delete via `deleteCryptoKey`. Toasts.

- [ ] **Step 2: Mount in SecurityPreferences**

In `SecurityPreferences.tsx` (~L300), add `<TrustedCasSection />` as a sibling of `<KeyManagerSection />` inside the `space-y-6 p-6` wrapper.

- [ ] **Step 3: `sync:crypto-result` listener**

In `useSyncEvents.ts`, mirror the `sync:bodies-written` listener (~L218-228): `listen<{ accountId: string; messageId: string }>('sync:crypto-result', (e) => { ... })`. On the event, if the `messageId` matches the currently-selected message, re-read via `getMessageCryptoResult` + update `selectedMessage`'s crypto fields (so a background re-verify refreshes the badge). Push a toast on a notable state change if useful.

- [ ] **Step 4: Test**

- `TrustedCasSection.test.tsx`: render → Import triggers the right invoke; Delete triggers `deleteCryptoKey`. Mock invoke + the cryptoKeys service.
- `useSyncEvents` test: emit a `sync:crypto-result` event (mock `listen`) → assert the re-read + selectedMessage update. Mirror the existing `useSyncEvents` test patterns.

Run: `npx vitest run src/components/preferences/TrustedCasSection.test.tsx src/hooks/useSyncEvents.test.ts && npx tsc --noEmit`

- [ ] **Step 5: Commit (SKIPPED)**

---

## Task 7: Final gates + carry-forward docs

- [ ] **Step 1: Consolidated gates**

Run: `cd kylins.client.frontend && npx tsc --noEmit && npx vitest run && npx eslint src`
Expected: tsc 0 errors; vitest all green; eslint clean.

- [ ] **Step 2: Document carry-forwards in the report + ledger**

G7 owns: Thunderbird interop (the cms_build.rs eContent double-wrap investigation; cross-impl kari decrypt; real CA-issued cert chain through the full pipeline). Hardening: granular ChainOutcome exposure for revoked-vs-unchecked UI (G5 deferred); the clear-signed `multipart/signed` receive path (the `smime.p7s` attachment — G5's orchestrator handles opaque pkcs7-mime only); CRL `nextUpdate` parsing in the fetcher.

- [ ] **Step 3: Commit (SKIPPED — user controls git)**

---

## Carry-forwards (from this plan → G7 / hardening)

- **G7 — Thunderbird interop:** our-signs→Thunderbird-verifies (cms_build.rs:65-68 eContent double-wrap) + Thunderbird-signs→Kylins-verifies (real CA-issued chain) + cross-impl kari decrypt.
- **Clear-signed `multipart/signed` receive:** G5's orchestrator handles `application/pkcs7-mime` (opaque) only; clear-signed (plaintext + `smime.p7s` attachment) needs a small orchestrator addition + frontend attachment handling.
- **Granular chain/revocation UI:** G5 persists `chain_valid`/`revocation_state` coarsely inferred from SignatureState; a G6+ refinement exposes the full `ChainOutcome` for revoked-vs-unchecked badge granularity.
- **Manual e2e (user-run):** `cargo tauri dev` → Preferences → Security → Trusted CAs (import a CA root) → receive a Thunderbird signed+encrypted mail → decrypts + shows ValidVerified; TrustDialog accept → re-verifies; decrypt-failure (encrypt to an account whose key is absent → no-key panel).

## Self-review

1. **Spec coverage:** §7.1 granular CryptoBadge = T2; §7.2 ReadingPane integration + decrypt-failure panel = T4; §7.3 TrustDialog = T5; §7.4 session plaintext cache = T1+T3; §7.5 KeyManager Trusted CAs = T6; the threadStore wiring (§7 implicit) = T3; services/types = T1; the sync:crypto-result listener = T6. All covered.
2. **Placeholders:** the TS types are complete (mirroring the Rust serde contract, incl. the snake/camel caveat). Where a backend arg shape or an existing service needs confirmation (db_put_trust_decision arg; whether crypto_import_key_from_path accepts cert-only), the step says "read the backend to confirm" — the implementer resolves against the committed Rust (not a placeholder).
3. **Type consistency:** `MessageCryptoResult` / `OpenCryptoResult` / `MailMessage` crypto fields named consistently across the Interfaces block + Tasks 1-6. The snake_case `OpenCryptoResult` / `ImapAttachment` vs camelCase `MessageCryptoResult` / `CryptoResultEvent` distinction is called out in Global Constraints + the types.
