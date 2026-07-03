# Send-Flow Hardening Design — IMAP/SMTP + EAS

> **Status:** Approved 2026-07-02; **amended same day** to move MIME building to the Rust backend (Stalwart `mail-builder`) and add large-send (200 MB+) support. Scope: harden the two existing providers' send path — structured draft → Rust-built MIME → transport — and verify send + receive end-to-end, before continuing Phase 3 (3c Gmail / 3d Graph). A detailed per-task SDD implementation plan will follow this spec.
>
> **Scope decisions (user, 2026-07-02):**
> - "Harden the 2 existing providers." Gmail/Graph send is deferred to 3c/3d.
> - Sent-save = engine-orchestrated via `Capabilities` (Option 1); plain `SendMail` now, SmartReply/SmartForward documented as future.
> - Per-account `save_sent_copy` setting (default on).
> - **Large sends are required** — "we have to support large emails, as some internal mailservers support large emails" (200 MB+).
> - **MIME is built in the Rust backend with `mail-builder`** (Stalwart) — not in the frontend. This reverses the earlier "keep `buildRawEmail` in the frontend" decision.

## Context

The mail engine already has a working **receive** flow for IMAP and EAS (Phase 3a/3e) and a working **send** flow for IMAP+SMTP. An audit on 2026-07-02 found:

- `MailSource::send(&self, raw_base64url: &str) -> Result<(), SourceError>` exists (`sync_engine/mod.rs:200`) and is the right abstraction level — **but the base64url-string payload does not scale** (multiple resident copies across IPC → JSON → SQLite → base64-decode; a 200 MB message becomes ~1 GB+ resident).
- **IMAP source send works** — delegates to `smtp_client::send_raw_email` (lettre), `imap_source.rs:1133`.
- **EAS source send is a stub** — `eas_source.rs:499` returns `nyi()`.
- **SMTP send never saves to Sent** — no IMAP APPEND after the SMTP send.
- The frontend MIME builder (`utils/emailBuilder.ts`, ~204 lines) hand-rolls multipart/alternative + multipart/related, 76-char base64 for attachments, `cid:` inline-image extraction, header folding, importance/read-receipt/classification headers.
- The offline queue + replay worker (`pending_operations`, `60·2ⁿ` backoff, max 10 retries) and the frontend send path (`Composer.handleSend` → `buildRawEmail` → `sync_apply_mutation({type:'send', rawBase64url})`) are in place.
- **EAS WBXML tag bug** in `eas/commands.rs:98-107`: the local ComposeMail aliases are wrong — `CM_MIME = 0x09` (should be `0x10`; `0x09` is `ReplaceMime`), `CM_REPLACE_MIME = 0x0E` (should be `0x09`), `CM_STATUS = 0x18` (should be `0x12`). The existing `build_send_mail_request` round-trip tests pass only because both encoder and decoder share the bug. The authoritative tokens already exist in `eas/wbxml/code_pages.rs` (ComposeMail page 21, lines 635-654) and `eas/wbxml/tags.rs` (`tags::compose`, lines 142-158) — the fix is to delete the wrong local aliases and use `tags::compose::*` directly. (The earlier claim that the ComposeMail page "is new" was wrong; 3a/3b already registered it.)

Three reference implementations were studied: **velo** (Rust — `send_raw_email(config, base64url)` + separate `imap_append_message`), **inbox-zero** (Gmail — `users.messages.send({ raw: base64url })`), **mailkit_arkts** (EAS — `SendMail` WBXML carrying raw MIME as an opaque blob). All confirm **raw-MIME-at-the-transport** is correct. The open question was *where* the MIME is built and *how* it crosses IPC; this spec answers: **built in Rust with `mail-builder`, crossed as a structured draft.**

## Goal

1. **Move MIME building to the Rust backend** using Stalwart `mail-builder` (0.4.4); delete the frontend `emailBuilder.ts` from the send path.
2. **Support large sends (200 MB+)** — no base64 over IPC, no giant blob in the queue; attachments are file-backed.
3. Implement **EAS send** (replace `nyi()` with a real `SendMail` WBXML call, fixing the tag bug).
4. Fix **SMTP save-to-Sent** so sent messages appear in the Sent folder.
5. Verify **send + receive end-to-end** for both IMAP/SMTP and EAS, including a large-attachment send.

## Non-goals (deferred, documented in §"Future enhancements")

- Gmail-API send and MS-Graph send — these land with their sources in 3c/3d (and their cloud size caps, 25 MB / ~4 MB, are hard limits there — large-send is genuinely impossible on those transports).
- EAS `SmartReply`/`SmartForward` — bandwidth optimization, documented future.
- Scheduled send (`deliverAt`) — no provider supports it natively; future client-side scheduler.
- **Near-zero-memory streaming** (`mail-builder::write_to(file)` + mmap'd attachments + streaming SMTP `DATA`) — documented future optimization; MVP builds to a `Vec<u8>` (peak ≈ encoded size, fine on desktop).

## Architecture

### Structured draft over IPC + Rust-side MIME building (the core change)

The frontend no longer builds MIME. It sends a **serializable `SendDraft`** plus **file-backed attachment references**; the Rust backend builds the RFC822 bytes with `mail-builder` once, then hands the same bytes to `send` and (for IMAP) `append`.

```rust
// New shared types (serde; frontend sends an equivalent TS object).
pub struct SendDraft {
    pub draft_id: String,                 // correlation; also the attachment dir name
    pub from: AddressSpec,
    pub to: Vec<AddressSpec>,
    pub cc: Vec<AddressSpec>,
    pub bcc: Vec<AddressSpec>,
    pub reply_to: Option<AddressSpec>,
    pub subject: String,
    pub html_body: Option<String>,        // prepared HTML (inline-CSS, signature, cid: refs already resolved)
    pub text_body: Option<String>,        // plain-text alternative (frontend generates from HTML)
    pub in_reply_to: Option<String>,      // Message-ID being replied to (threading)
    pub references: Option<Vec<String>>,
    pub attachments: Vec<AttachmentRef>,  // regular attachments
    pub inline_images: Vec<AttachmentRef>,// Content-ID inline parts (cid: in html_body)
    pub extra_headers: Vec<(String, String)>, // importance/read-receipt/classification (computed by frontend, same logic as today)
}

pub struct AttachmentRef {
    pub file_path: String,     // absolute path under <appData>/outbox-attachments/{draft_id}/
    pub filename: String,      // display name (Content-Disposition filename)
    pub mime_type: String,
    pub cid: Option<String>,   // Some for inline_images (matches the cid: used in html_body)
}
```

The `MailSource::send` trait method changes from a base64url string to raw bytes (the engine builds, the transport consumes):

```rust
async fn send(&self, raw_mime: &[u8]) -> Result<(), SourceError>;
```

Per transport:
- **IMAP/SMTP**: `smtp_client::send_raw_email(config, raw_mime)` (lettre; `&[u8]` now, no base64 decode).
- **EAS**: wrap `raw_mime` in a `SendMail` WBXML **opaque** element → POST.
- **Gmail API** (3c) / **Graph** (3d): accept the same `&[u8]` (base64-encode inside the provider's HTTP body — Gmail's 25 MB cap is a hard limit there).

### Why `mail-builder` (Stalwart)

Verified against docs.rs/mail-builder **0.4.4** (Apache-2.0/MIT, optional-only `gethostname` dep, pairs with the `mail-parser` we already use inbound):

```rust
MessageBuilder::new()
    .from(...).to(...).cc(...).bcc(...).reply_to(...)
    .subject(...).in_reply_to(...).references(...)
    .header("X-Priority", "1")                     // custom headers (importance/read-receipt/classification)
    .text_body(...)                                 // multipart/alternative auto-built when both set
    .html_body(...)                                 //   (multipart/related auto-built when inline images exist)
    .inline("image/png", "cid:logo", body_bytes)    // Content-ID inline image
    .attachment("application/pdf", "report.pdf", body_bytes)
    .write_to_vec()                                 // -> Vec<u8>  (or .write_to(impl Write) to stream)
```

Multipart structure (alternative/related/mixed), per-part encoding selection (base64 vs quoted-printable), and header folding are handled by the crate — so the frontend's manual 76-char base64 + multipart assembly + cid extraction becomes redundant. One `write_to_vec()` produces the RFC822 bytes.

**Honest memory note:** `BodyPart<'x> = Text(Cow<str>) | Binary(Cow<[u8]>) | Multipart(Vec<MimePart>)` — attachments are **bytes**, not files/readers. So `mail-builder` streams at the *write* step (`write_to_vec` encodes incrementally, no separate base64-string copy), not the *input* step. For a 200 MB message, peak resident is ≈ the encoded `Vec<u8>` (~267 MB) — fine on desktop, and a fraction of the current 4–5× base64 copies across IPC/JSON/SQLite. The wins are: **(a)** no base64 over IPC, **(b)** no base64-string copy, **(c)** a small structured draft in the queue (not a giant blob), **(d)** one unified Rust builder for every transport, **(e)** AI-initiated sends (Phase A1/D) compose MIME with zero frontend round-trip.

### Sent-save orchestration (engine-orchestrated via `Capabilities`)

Sent-copy semantics differ by transport:
| Transport | Sent-copy mechanism |
|---|---|
| IMAP/SMTP | **Manual** — SMTP does not save; client must IMAP APPEND to Sent. |
| EAS | **Flag in send** — `SaveInSentItems` tag inside the `SendMail` request; server saves. |
| Gmail API | **Automatic** — server always saves to Sent. |
| Graph | **Automatic** — `sendMail` always saves to Sent. |

```rust
pub struct Capabilities {
    // ...existing fields (idle, condstore, qresync, ping, vanishearch)...
    /// True when the server stores a Sent copy as part of the send call itself
    /// (EAS SaveInSentItems, Gmail/Graph auto-save). False when the client must
    /// append to Sent separately (IMAP/SMTP).
    pub saves_sent_automatically: bool,
}
```

- **`send(raw_mime)` stays atomic per-provider** — it does *only* the transport. EAS includes `SaveInSentItems` (so `saves_sent_automatically = true`); IMAP is SMTP-only (`false`).
- **The replay worker orchestrates the Sent copy**: after `send` succeeds, if `!capabilities().saves_sent_automatically && save_sent_copy_setting`, resolve the account's Sent folder and call the **existing** `MailSource::append(&sent_folder, raw_mime, &["\\Seen"])`, **best-effort**, reusing the *same* MIME bytes just built.
- **Best-effort means:** a Sent-append failure is logged and surfaced via `sync:status` as a warning, but does **not** fail or retry the send (retrying would re-run SMTP and duplicate the send). The email was already delivered; the Sent copy is a local-comfort concern.
- **Per-account `save_sent_copy` setting** (settings KV, templated key `account.{id}.save_sent_copy`, default `true`): if false, the engine skips the append even for IMAP (for users who know their SMTP server auto-saves, e.g. Gmail-via-SMTP).

**Why engine-orchestrated over "encapsulate inside `send`":** keeps `send` the clean retryable unit; makes the best-effort nature explicit; reuses `append` — no new trait method.

**Sent-folder resolution** (preference order): (1) per-account `sent_folder_path` override in settings KV; (2) the folder whose synced `special_use`/`role` is `\Sent`/`sent` (the schema stores this — see `db::labels::get_folder_by_role`); (3) conventional name `Sent` / `Sent Items`.

### The replay worker owns the Send op end-to-end

The Send op is special (build → send → best-effort append → cleanup), so the worker handles it directly rather than through the generic `exec_via_source` dispatcher:

```rust
// pseudocode — engine.rs replay worker, Send arm
let MutationOp::Send { draft } = &op else { /* other ops -> exec_via_source */ };
let mime = message_builder::build_mime(draft).await?;   // reads attachment files, assembles via mail-builder
src.send(&mime).await?;                                  // SMTP or EAS SendMail
if !src.capabilities().saves_sent_automatically && save_sent_copy(account_id) {
    if let Some(sent) = resolve_sent_folder(account_id).await {
        if let Err(e) = src.append(&sent, &mime, &["\\Seen"]).await {   // best-effort
            emit_sync_warning(account_id, "sent-append failed", e);     // do NOT fail the op
        }
    }
}
cleanup_attachment_files(&draft.draft_id);               // delete <appData>/outbox-attachments/{draft_id}/
mark_completed(&op);
```

A `build_mime` failure (e.g. attachment file missing, `mail-builder` error) → op fails → `mark_failed` → retry. A missing attachment file will not self-heal → eventual permanent-fail (correct: the user must re-attach).

### Large sends (200 MB+)

- **No base64 over IPC.** The `SendDraft` crosses Tauri IPC as a small JSON object; attachment *paths* cross, not bytes.
- **Attachments are file-backed.** When the user attaches a file, the frontend copies it (async, non-blocking) to `<appData>/outbox-attachments/{draft_id}/{filename}`; the draft carries the path. `message_builder` reads each file when assembling.
- **The queue stores the structured draft**, not the MIME — so a 200 MB send adds a small JSON row to `pending_operations`, not a 267 MB blob.
- **Peak memory** ≈ one encoded MIME `Vec<u8>` (~267 MB at 200 MB) during build+send; the attachment files are read one at a time into `mail-builder`. Acceptable on desktop.
- **Cloud transports can't do this** — Gmail (25 MB) and Graph (~4 MB) reject oversize messages at the HTTP layer; large-send is a property of the IMAP/SMTP and EAS paths (internal mail servers with raised limits). The provider returns a size error; the op fails with an actionable message.
- **Future near-zero-memory path** (documented, not MVP): `mail-builder::write_to(temp file)` (stream encoded output to disk) + `memmap2` attachment files (zero-copy `&[u8]` into `mail-builder`) + streaming SMTP `DATA` (chunked write to the socket). Today's `send(&[u8])` trait accommodates this — a future impl can build to a file and stream it.

## Attachment lifecycle

| Event | Action |
|---|---|
| User attaches a file (dialog) | Frontend async-copies to `<appData>/outbox-attachments/{draft_id}/{filename}`; stores `AttachmentRef{file_path, ...}` in the in-memory draft. |
| User inserts inline image (TipTap) | Frontend writes the image bytes to the same dir under a generated name; rewrites the `<img src>` to `cid:{cid}`; adds an `inline_images` ref. |
| User discards the draft (cancel) | Frontend deletes the draft's attachment dir. |
| `send` succeeds (`mark_completed`) | Worker deletes the draft's attachment dir. |
| `send` transient-fail (`mark_failed`) | Keep files + queue row (retry will reuse them). |
| `send` permanent-fail (max retries) | Keep files + row; surface a "stuck send" warning; user can retry or cancel (cancel deletes files). |

The `draft_id` is assigned at compose start and carried in the `SendDraft`; the queue row's `resource_id` is `"send:{draft_id}"`. Frontend writes via the Tauri `fs` plugin; `appDataDir` resolves the root.

## Component changes

### Backend (Rust)

1. **New dep**: `mail-builder = "0.4"` in `kylins.client.backend/Cargo.toml`. (Already use `mail-parser` inbound; `mail-builder` is the companion.)

2. **New module `mail/builder/` (or `message_builder`)** — `build_mime(draft: &SendDraft) -> Result<Vec<u8>>`:
   - Read each `AttachmentRef` file into bytes (`tokio::fs`).
   - `MessageBuilder::new()` → set from/to/cc/bcc/reply_to/subject/in_reply_to/references; apply `extra_headers` via `.header()`; set `html_body`/`text_body`; add inline images via `.inline(mime_type, cid, bytes)`; add attachments via `.attachment(mime_type, filename, bytes)`.
   - `.write_to_vec()` → return the RFC822 bytes.
   - Define `SendDraft` / `AttachmentRef` / `AddressSpec` (serde) here, shared with the IPC layer.

3. **`sync_engine/mod.rs`**:
   - `Capabilities`: add `saves_sent_automatically: bool`.
   - `MailSource::send`: `async fn send(&self, raw_mime: &[u8]) -> Result<(), SourceError>;` (was `raw_base64url: &str`).
   - `append` is unchanged (`&[u8]` already).

4. **`MutationOp::Send`**: change to `Send { draft: SendDraft }` (was `raw_base64url: String`). Update serialization + the IPC `sync_apply_mutation` payload (`{ type:'send', draft }`).

5. **`db/mutations.rs` / `sync_engine/engine.rs`** — replay worker: handle the Send op end-to-end as shown above (build → send → best-effort append → cleanup). Remove/retire the Send arm from the generic `exec_via_source` dispatcher (the worker owns it now).

6. **`sync_engine/imap_source.rs`**:
   - `capabilities()`: set `saves_sent_automatically = false`.
   - `send(&self, raw_mime: &[u8])`: pass straight to `smtp_client::send_raw_email(config, raw_mime)`.

7. **`smtp_client`**: `send_raw_email(config, raw_mime: &[u8])` — drop the base64url-decode step (was `base64url: &str`).

8. **`sync_engine/eas_source.rs`**:
   - `capabilities()`: set `saves_sent_automatically = true` (EAS `SaveInSentItems`).
   - `send(&self, raw_mime: &[u8])`: build the `SendMail` WBXML (opaque `<Mime>`) and POST via the 3b client (see §"EAS SendMail").

9. **EAS WBXML** — **fix the tag bug**: delete the wrong local aliases in `eas/commands.rs:98-107` (`CM_MIME=0x09`, `CM_REPLACE_MIME=0x0E`, `CM_STATUS=0x18`); use `tags::compose::{MIME=0x10, SAVE_IN_SENT_ITEMS=0x08, CLIENT_ID=0x11, STATUS=0x12, SEND_MAIL=0x05}` directly. The code page + `tags::compose` already exist (3a/3b). Add a **golden-bytes** assertion for the opaque `<Mime>` block so the regression can't return.

10. **`eas/status.rs`**: add `recovery_action_for_send_mail(status)` — SendMail status codes are *send* errors (not sync-state); map `140/141/142-144` → provisioning, `111/132` → retry, `130/131` → fatal-auth, `150` → item-not-found (relevant for SmartReply). SendMail success = empty response body (no `<Status>`).

### Frontend (TypeScript)

1. **New `services/composer/buildSendDraft.ts`** (replaces `buildRawEmail` in the send path): produce a `SendDraft` from the composer state — prepared HTML (inline-CSS, signature, `cid:`-resolved inline images) + plain-text alternative + `extra_headers` (importance/read-receipt/classification, **same logic as today's `emailBuilder.ts`**) + `AttachmentRef[]` (paths under `<appData>/outbox-attachments/{draft_id}/`).

2. **Attachment handling**: on attach, async-copy the picked file to the draft's app-data dir (Tauri `fs` plugin); on inline-image insert, write the image + rewrite `src` to `cid:`. Track `draft_id` for the compose session.

3. **`services/composer/send.ts`**: `sendEmail` → `buildSendDraft` → `invoke('sync_apply_mutation', { accountId, op: { type:'send', draft } })`. No MIME, no base64.

4. **Remove `utils/emailBuilder.ts`** from the send path once `buildSendDraft` + Rust `message_builder` cover parity (multipart/alternative, inline `cid:`, importance/read-receipt/classification headers). Keep a parity checklist in the plan.

5. **Sent-folder refresh** after `SEND_COMPLETE_EVENT` (verify the existing `sync:delta` listener covers the appended copy; add a Sent-folder reload if not).

### EAS SendMail

Replace `eas_source.rs:499`:

```rust
async fn send(&self, raw_mime: &[u8]) -> Result<(), SourceError> {
    // 1. Build WBXML body (ComposeMail page 0x15), using tags::compose::* (NOT the buggy local aliases):
    //    SendMail(0x05) {
    //      ClientId(0x11)         = "SendMail-{uuid}"        // correlation (STR_I)
    //      SaveInSentItems(0x08)  = <empty tag>               // server saves the copy
    //      Mime(0x10)             = OPAQUE(raw_mime bytes)    // 0xC3 + mb_u_int32(len) + raw bytes, NOT base64
    //    }
    let client_id = format!("SendMail-{}", uuid::Uuid::new_v4());
    let wbxml = eas::wbxml::build_send_mail(raw_mime, &client_id)?;

    // 2. POST via the 3b client's send_command_no_retry to the SendMail endpoint.
    //    Headers (already set by client): Authorization (Basic/OAuth), Content-Type: application/vnd.ms-sync.wbxml,
    //    MS-ASProtocolVersion, X-MS-PolicyKey (if provisioned), User-Agent.
    let response = self.client.send_command_no_retry("SendMail", &wbxml).await?;

    // 3. Parse: empty body / HTTP 200 = success. A <Status> element => map via recovery_action_for_send_mail.
    eas::send_mail::parse_response(response.body())?;
    Ok(())
}
```

Key protocol facts (from AOSP Android Exchange + mailkit, verified 2026-07-02):
- **`<Mime>` is raw bytes inside a WBXML OPAQUE block** (`0xC3` + multi-byte length + bytes), **not base64**. The serializer's `opaque(&[u8])` already does this correctly (verified `wbxml/serializer.rs`).
- **`SaveInSentItems` is an empty (self-closing) tag** for EAS 14.0+ (our target — 3b targets 14.1).
- **`ClientId`** is a client-generated correlation string.
- **Success = empty response body.** A `<Status>` element indicates an error.
- **No `Source` element** for plain `SendMail` (only for SmartReply/SmartForward).
- **Attachments are inside the MIME** (multipart/mixed, assembled by `mail-builder`) — no separate EAS attachment upload for `SendMail`.

### IMAP/SMTP send

Already works mechanically. Changes: `send(&[u8])` passes bytes straight to `send_raw_email(config, &[u8])` (no base64 decode); `Capabilities.saves_sent_automatically = false` makes the engine append to Sent after success.

**Sent-append strategy (MVP): simple always-APPEND**, gated by the per-account `save_sent_copy` setting (default on). Correct for classic IMAP+SMTP (Postfix/Dovecot do not auto-save). The Mailspring **check-then-append** pattern (scan Sent for the Message-ID to avoid duplication on Gmail-via-SMTP) is a **future refinement**; unnecessary now because Gmail will connect via the Gmail API in 3c.

## Data flow (end-to-end)

### Send (revised)

```
Composer.handleSend (5s undo timer)
  -> buildSendDraft(DraftInput)          [frontend TS]  -> SendDraft (small JSON) + attachment files already staged
  -> invoke('sync_apply_mutation', { accountId, op: { type:'send', draft } })
  -> engine.apply_mutation_inner:
       local writes (no-op for send) -> enqueue pending_operations row (resource_id = "send:{draft_id}", payload = SendDraft JSON)
       -> nudge replay worker
  -> replay worker drains queue (Send op handled inline):
       message_builder::build_mime(&draft)            [Rust, mail-builder] -> Vec<u8> RFC822
       src.send(&mime)
         IMAP: smtp_client::send_raw_email(config, &mime)   (existing, now &[u8])
         EAS:  SendMail WBXML opaque                       (NEW)
       on success:
         if !saves_sent_automatically && save_sent_copy(account):
           src.append(Sent, &mime, [\Seen])                // best-effort (NEW); reuses same bytes
         cleanup_attachment_files(draft_id)
         mark_completed (delete row)
         emit sync:delta / sync:queue
       on failure:
         mark_failed (60·2^retry_count sec backoff, max 10)
  -> frontend: SEND_COMPLETE_EVENT -> Sent folder refresh
```

### Receive (already works — for context)

```
sync_start -> per-account workers (IMAP poll 60s / IDLE; EAS ping)
  -> source.sync_folder(cursor) -> FolderDelta -> apply_folder_delta -> DB
  -> emit sync:delta -> folderStore + threadStore refresh (debounced)
body fetch on-demand: sync_request_bodies -> source.fetch_body -> message_bodies
```

## Error handling and retry semantics

- **Send is the retryable unit.** A `send` failure (SMTP transient, EAS status 111/132, network) → `mark_failed` → exponential backoff (`60·2^retry_count` s, max 10, then `status='failed'`). Existing infra.
- **Sent-append is best-effort, never retried.** A Sent-append failure after a successful send is logged + surfaced as a `sync:status` warning. It must not trigger a send retry.
- **Build failures** (`message_builder::build_mime`): a missing/unreadable attachment file or `mail-builder` error fails the op. Transient I/O errors retry; a permanently-missing file retries until max then permanent-fails (user must re-attach). Distinguished from transport failures in logs.
- **EAS SendMail status codes** map through the new `recovery_action_for_send_mail`. SendMail success is an empty body.
- **Size-limit errors** (Gmail 25 MB / Graph ~4 MB) surface as an actionable op failure when those providers land (3c/3d); not relevant to IMAP/EAS large-send.
- **Frontend undo-send** stays a client-side 5s timer before the `sync_apply_mutation` invoke — transport-agnostic, unchanged.

## Verification (end-to-end)

1. **IMAP/SMTP — real server (`felixzhou@kylins.local`, `imap/smtp.kylins.com` STARTTLS):**
   - Send to self (or a second account) → confirm SMTP transport succeeds.
   - Confirm the Sent APPEND lands (Sent folder shows the message).
   - Confirm receive picks it up (IDLE/poll → appears in Inbox).
   - **Large send:** attach a >100 MB file → confirm it sends, the Sent copy lands, and peak memory stays bounded (no OOM). **Both directions exercised on a real server.**
2. **EAS — WBXML unit tests** (mirror the 3b round-trip tests): **golden request bytes** for a known MIME fixture (assert the opaque `<Mime>` block byte-for-byte — this catches the tag-bug regression); status-response parsing for success (empty) + each error code → correct `SourceError`/recovery mapping. **Real-Exchange send e2e is deferred** (folds into the pending 3a/3b manual EAS e2e).
3. **`message_builder` unit tests:** multipart/alternative present when both bodies set; inline `cid:` image produces `multipart/related` + matching `Content-ID`; attachment produces `multipart/mixed` + base64 encoding; custom headers applied; **parity fixtures** comparing output against the old frontend `emailBuilder.ts` for representative drafts (plain text, HTML+inline-image, HTML+attachment, reply with `In-Reply-To`/`References`).
4. **Offline/retry:** disconnect → send → confirm the row queues (`status='pending'`) → reconnect → confirm backoff-driven retry succeeds → `mark_completed` → attachment files deleted.
5. **Sent-append best-effort:** force an IMAP APPEND failure (e.g. read-only Sent) after a successful SMTP send → confirm the send is still `mark_completed` and a `sync:status` warning is emitted (no duplicate send on retry).
6. **Frontend:** existing send vitest updated for `buildSendDraft`; add a Sent-folder-refresh-after-send assertion if the `sync:delta` path doesn't already cover it.

Backend gates: `cargo test --lib` (`message_builder` parity tests + EAS SendMail golden-bytes + engine Sent-append-branch test) + `cargo clippy --all-targets -D warnings`. Frontend gates: `tsc --noEmit` + `vitest`.

## Future enhancements (documented, out of scope here)

### EAS SmartReply / SmartForward

A bandwidth optimization: instead of `Cmd=SendMail` uploading the full reply MIME (re-uploading the quoted original), `Cmd=SmartReply`/`Cmd=SmartForward` sends a `Source` referencing the original's `ItemId` + a *partial* MIME; the server stitches them. **Prerequisites:** (1) `SendDraft` extends to carry `in_reply_to_server_id: Option<String>` + `smart_send: bool` (the EAS ServerId must be threaded from the message list through the composer — a ServerId→uid map table is already a known Phase-3 carry-over); (2) a "compose without quoted original" mode for the EAS path. **Design hook:** `send(&[u8])` is unchanged; the EAS `send` impl branches on the extended draft. Plain `SendMail` is the foundation. velo/Mailspring don't implement SmartReply/SmartForward; mailkit does.

### Near-zero-memory streaming (large sends, phase 2)

`mail-builder::write_to(temp file)` (stream encoded output to disk instead of a `Vec<u8>`) + `memmap2` attachment files (zero-copy `&[u8]` view, no heap read) + streaming SMTP `DATA` (chunked write to the lettre socket). The `send(&[u8])` trait accommodates a future `send(mime_path)` variant. Defer until a real 500 MB+ workload demands it.

### Gmail-API send and Graph send

Land with their sources in 3c/3d. Gmail: `POST /gmail/v1/users/me/messages/send { raw, threadId? }` (auto-saves; 25 MB cap). Graph: `POST sendMail` with the MIME (auto-saves; ~4 MB cap). OAuth refresh reused from 3b's `eas::auth` OAuth path / the 3c plan.

### Scheduled send (`deliverAt`)

`DraftInput.deliverAt` exists but no provider supports scheduled send natively. Future: a client-side scheduler that holds the `send` op until `deliverAt`, then enqueues.

## Decision log

1. **MIME is built in Rust with `mail-builder`** (reverses the earlier "keep `buildRawEmail` in the frontend" decision). User-directed after the large-send requirement made the base64-over-IPC pipeline untenable. `mail-builder` pairs with `mail-parser`, deletes ~204 lines of frontend MIME code, and enables AI-initiated sends.
2. **Structured `SendDraft` over IPC + file-backed attachments** — no base64, no MIME, no large blob in the queue. Attachments staged under `<appData>/outbox-attachments/{draft_id}/`.
3. **`send(&self, raw_mime: &[u8])`** — engine builds once, transports consume bytes; `append` reuses the same bytes. Raw-MIME-at-the-transport confirmed by velo/inbox-zero/mailkit.
4. **Sent-save = engine-orchestrated via `Capabilities` + best-effort `append`** (Option 1) over encapsulate-in-`send` (Option 2). Keeps `send` atomic and the best-effort nature explicit; reuses `append`.
5. **EAS send = plain `SendMail` only** — no SmartReply/SmartForward in this pass (documented future).
6. **EAS WBXML tag bug fixed** — use `tags::compose::*`, delete the wrong local aliases in `commands.rs`, add a golden-bytes regression test.
7. **Gmail/Graph send deferred to 3c/3d** — their sources don't exist yet; their cloud size caps make large-send impossible there anyway.
8. **SMTP Sent-append = simple always-APPEND** (per-account `save_sent_copy` toggle) for MVP; check-then-append is a future refinement for the Gmail-via-SMTP edge case.

## References

- **`mail-builder` (Stalwart)** — docs.rs/mail-builder 0.4.4: `MessageBuilder`, `BodyPart` (`Text`/`Binary(Cow<[u8]>)`/`Multipart`), `.inline(content_type, cid, body)`, `.attachment(...)`, `.write_to_vec()` / `.write_to(impl Write)`. License Apache-2.0 OR MIT. Companion to `mail-parser` (already used inbound).
- **velo** — `src-tauri/src/smtp/client.rs:150` (`send_raw_email`), `src-tauri/src/commands.rs:219` (`imap_append_message`).
- **inbox-zero** — `apps/web/utils/gmail/mail.ts:114` (`users.messages.send({ raw })`).
- **mailkit_arkts** — `common/MailKit/.../activesync_mail_store_service.ets:195` (`send`), `send_mail_request.ets:24` (WBXML builder).
- **AOSP Android Exchange** — `EasOutboxSync.java:486` (`SendMailEntity.writeTo`), `Serializer.java:196` (opaque), `Rfc822Output.java` (MIME).
- **Mailspring** — `mailsync/MailSync/TaskProcessor.cpp:1614` (check-then-append Sent pattern).
- **Existing Kylins code** — `sync_engine/mod.rs:200` (`MailSource::send`), `:194` (`append`), `:20` (`Capabilities`); `imap_source.rs:1133` (IMAP send); `eas_source.rs:499` (EAS stub); `eas/commands.rs:98-107` (tag bug); `eas/wbxml/code_pages.rs:635-654` + `eas/wbxml/tags.rs:142-158` (correct ComposeMail tags); `eas/wbxml/serializer.rs` (`opaque`); `eas/client.rs:173` (`send_command_no_retry`); `db/queue.rs:237` (`mark_failed` backoff); `db/labels.rs:168` (`get_folder_by_role`); `db/settings.rs` (KV); `utils/emailBuilder.ts` (frontend MIME — to be removed).
