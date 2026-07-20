# S/MIME Thunderbird Interop — Manual E2E Procedure

> **Phase 1b Plan 5 (G7) Task 4.** This is the user-run manual e2e gate for S/MIME interop between Kylins and Thunderbird. Run each scenario + record the outcome. If a scenario fails, capture Thunderbird's S/MIME error UI + the Kylins logs (`reveal_logs_directory` IPC cmd, or grep `[send]`/`[crypto]`) for diagnosis.

## Prerequisites

- **Kylins:** `cargo tauri dev` from `kylins.client.backend/`.
- **Thunderbird:** installed + configured with an S/MIME cert (self-signed or CA-issued) + the IMAP account matching Kylins (`felixzhou@kylins.local` / `imap.kylins.com` STARTTLS, accept invalid certs).
- **Both accounts** on the same IMAP server so you can send/receive between them.

## Setup (Kylins)

1. Launch `cargo tauri dev`.
2. **Preferences → Security → "Your S/MIME Keys":** Import PEM (cert + key) OR Generate self-signed → Set default signing key.
3. **Preferences → Security → "Trusted CAs":** Import the CA root that signed the Thunderbird cert (if CA-issued; for self-signed, import the Thunderbird self-signed cert as a trusted CA).
4. **Compose a test mail** to verify the account works (plain, no crypto).

## Scenario 1: Receive signed+encrypted (Thunderbird → Kylins)

1. In Thunderbird, compose a message to the Kylins account.
2. **Security → Encrypt this message + Digitally Sign this message.**
3. Send. Wait for IMAP IDLE or manual refresh.
4. In Kylins, open the message.
5. **Expected:** CryptoBadge shows a green checkmark (ValidVerified) + a solid lock (decrypted). The decrypted body renders in the reading pane. If the signer isn't trusted, the TrustDialog appears → "Trust signer" → re-verifies to ValidVerified.
6. **If fails:** check Kylins logs for `[crypto]` errors; check whether the Thunderbird cert's chain validates against the imported Trusted CAs.

## Scenario 2: Receive signed-only (Thunderbird → Kylins)

1. In Thunderbird, compose → **Digitally Sign only** (no encrypt).
2. Send → open in Kylins.
3. **Expected:** CryptoBadge shows the signature glyph (no lock — not encrypted). The plaintext body renders. Verify state per the signer trust.
4. **If the message is clear-signed (`multipart/signed`):** the body is plaintext + a `.p7s` attachment. Kylins's `open_crypto_message` clear-signed path (G7 T2) extracts part 1 + verifies the detached signature.

## Scenario 3: Receive encrypted-only (Thunderbird → Kylins)

1. In Thunderbird, compose → **Encrypt only** (no sign).
2. Send → open in Kylins.
3. **Expected:** CryptoBadge shows a solid lock (decrypted) + "not-signed" (no signature glyph). The decrypted body renders.

## Scenario 4: Send signed+encrypted (Kylins → Thunderbird)

1. In Kylins, compose a message to the Thunderbird account.
2. Toggle **Encrypt + Sign** in the compose ribbon.
3. Send.
4. In Thunderbird, open the message.
5. **Expected:** Thunderbird decrypts + verifies the signature. The badge shows "valid signature" (may say "untrusted signer" if the Kylins cert isn't in Thunderbird's trust store — that's expected for self-signed).
6. **This validates the G7 T1 eContent double-wrap fix** — if Thunderbird CANNOT verify the signature (messageDigest mismatch), the eContent fix is incomplete. This is the critical OUR-SIGNS→THUNDERBIRD-VERIFIES direction.

## Scenario 5: Decrypt-failure (no matching key)

1. In Thunderbird, encrypt a message to a DIFFERENT recipient (not the Kylins account's key).
2. Send → open in Kylins.
3. **Expected:** The decrypt-failure panel renders ("Can't decrypt — no matching private key") instead of the body. The CryptoBadge shows a broken lock. No crash.

## Scenario 6: Clear-signed (multipart/signed)

1. In Thunderbird, compose → **Digitally Sign** (Thunderbird defaults to clear-signed `multipart/signed` unless configured for opaque).
2. Send → open in Kylins.
3. **Expected:** The plaintext body renders + the signature verifies (CryptoBadge shows the signature glyph). The `.p7s` attachment is consumed for verification (not displayed as a download).

## Scenario 7: Untrusted signer → TrustDialog

1. Receive a signed message from a signer whose cert is NOT in the Kylins Trusted CAs store.
2. Open in Kylins.
3. **Expected:** The TrustDialog appears ("Signature valid; chain roots are not in your trust anchor set").
4. Click **"Trust signer"**.
5. **Expected:** The dialog closes + the CryptoBadge flips to ValidVerified (the session cache is evicted + `open_crypto_message` re-runs with the fresh trust decision).

## Scenario 8: CRL revocation (if a revoked cert is obtainable)

1. Obtain a cert that has been revoked by its CA (the CA's CRL must be fetchable via the CRL distribution point URL).
2. Receive a message signed by the revoked cert.
3. **Expected:** The CryptoBadge shows `Invalid` (the CRL hard-fails: `revocation_state=revoked`, `chain_valid=false`). The body still renders (the signature is cryptographically valid; the chain is rejected for revocation).

## Outcomes

Record each scenario's outcome (PASS/FAIL + notes). If any fails, the failure details feed into G7 T5 (interop-bug triage + fix). If all pass, Phase 1b S/MIME is interop-validated both directions.
