# Send-Flow Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Strict SDD**: fresh implementer subagent per task, controller review between tasks, ledger entry per task.
>
> **Spec:** `docs/superpowers/specs/2026-07-02-send-flow-hardening-design.md` (read it first).

**Goal:** Move outbound MIME building to the Rust backend (Stalwart `mail-builder`), pass a structured `SendDraft` + file-backed attachments over IPC (no base64 blob — supports 200 MB+ sends), implement real EAS `SendMail`, fix SMTP save-to-Sent, and verify send+receive end-to-end.

**Architecture:** Frontend `buildSendDraft` → `invoke('sync_apply_mutation', {op:{type:'send', draft}})`. The replay worker builds RFC822 bytes once via `message_builder::build_mime(&draft)` (mail-builder), calls `MailSource::send(&[u8])`, then (IMAP only) best-effort `append(&[u8])` to Sent. Attachments are staged under `<appData>/outbox-attachments/{draft_id}/` and cleaned up on success.

**Tech Stack:** Rust — `mail-builder = "0.4"` (new), existing `mail-parser`, `lettre`, `tokio`. TypeScript — React 19, `@tauri-apps/api` + `@tauri-apps/plugin-fs`, Vitest. Tauri v2 IPC.

## Global Constraints

- **DO NOT `git commit` or `git push`.** The user controls all git operations. Leave every change uncommitted. The controller reviews the diff between tasks and records a ledger entry; nothing is committed unless the user explicitly asks.
- **Strict SDD per task.** Fresh implementer subagent per task; controller review (diff + tests) before the next task; one ledger line per task in `.superpowers/sdd/progress.md` (or the project's ledger file — check what exists).
- **Backend crate dir:** `kylins.client.backend/`. **Frontend pkg dir:** `kylins.client.frontend/`. Run commands from the correct sub-package.
- **Backend test (single):** `cargo test --lib <name_substring>` (from backend dir). **Full:** `cargo test --lib` + `cargo clippy --all-targets -- -D warnings`.
- **Frontend test (single):** `npx vitest run <path>` (from frontend dir). **Type-check:** `npx tsc --noEmit`. **Full:** `tsc --noEmit` + `npx vitest run`.
- **Serde convention:** all new IPC types use `#[serde(rename_all = "camelCase")]` so Rust↔TS field names match (`raw_base64url` ↔ `rawBase64url`, `file_path` ↔ `filePath`). `MutationOp` already follows this.
- **TypeScript strictness:** `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` are on. Path alias `@/*` → `src/*`.
- **mail-builder version:** `0.4` (latest 0.4.4 verified on docs.rs). Verify the exact `Address` constructor signature against docs.rs when implementing T1 — the crate offers both `.from((name, email))` tuple form and `Address::new_address(name, email)`.
- **The crypto fail-closed send guard is PLANNED ONLY** (spec `2026-06-29-crypto-system-design.md` Phase S). Do NOT implement it here. `is_encrypted`/`is_signed` flags are ignored on send in this plan (pre-existing behavior); that work is tracked separately.
- **No `Date.now()`/`Math.random()` in Workflow scripts** — irrelevant here (this is Rust/TS app code, not a workflow script), but noted for completeness.
- **`source_for_account` returns `ImapSource` or `EasSource` only** (3c Gmail / 3d Graph deferred). Don't add new branches.

---

## File Structure

### Backend (`kylins.client.backend/src/`)

| File | Responsibility | Task |
|---|---|---|
| `Cargo.toml` | add `mail-builder = "0.4"` | T1 |
| `mail/mod.rs` | add `pub mod builder;` | T1 |
| `mail/builder.rs` (new) | `SendDraft`/`AttachmentRef`/`AddressSpec` serde types + `build_mime(&SendDraft) -> Result<Vec<u8>, String>` | T1, T2 |
| `sync_engine/mod.rs` | `Capabilities += saves_sent_automatically`; `MailSource::send(&[u8])` | T3 |
| `mail/smtp/client.rs` | `send_raw_email(config, &[u8])` (drop base64url decode) | T3 |
| `sync_engine/imap_source.rs` | `send(&[u8])`; `capabilities().saves_sent_automatically = false` | T3 |
| `sync_engine/eas_source.rs` | `send(&[u8])` signature (T3) → real wiring (T5); `capabilities().saves_sent_automatically = true` (T3) | T3, T5 |
| `sync_engine/mock_source.rs` | `send(&[u8])` signature | T3 |
| `db/mutations.rs` | `MutationOp::Send { draft }`; retire Send arm from `exec_via_source` | T3, T6 |
| `eas/commands.rs` | fix tag constants; `SendMailRequest` raw bytes + `client_id`; `build_send_mail_request` OPAQUE `<Mime>`; `parse_send_mail_response` | T4 |
| `eas/status.rs` | `recovery_action_for_send_mail` | T5 |
| `sync_engine/engine.rs` | `run_replay_round` — Send op: build → send → best-effort append → cleanup | T6, T8 |
| `db/labels.rs` | `resolve_sent_folder` helper (wraps `get_folder_by_role` + fallbacks) | T8 |
| `db/settings.rs` | (no change — reuse `get_bool` with templated key) | T8 |

### Frontend (`kylins.client.frontend/src/`)

| File | Responsibility | Task |
|---|---|---|
| `services/composer/types.ts` (new) | `SendDraft`/`AttachmentRef`/`AddressSpec` TS types | T7 |
| `services/composer/buildSendDraft.ts` (new) | `DraftInput` → `SendDraft`; inline-image cid extraction to files | T7 |
| `services/composer/attachments.ts` (new) | stage-to-app-data, `draft_id`, cleanup | T7 |
| `services/composer/send.ts` | invoke `{type:'send', draft}` | T7 |
| `services/composer/drafts.ts` | `DraftInput.attachments` → path-based | T7 |
| `utils/emailBuilder.ts` | keep `htmlToPlainText`/`extractInlineImages`; remove `buildRawEmail` + base64/multipart assembly | T7 |
| *(composer attachment picker)* | stage file to app-data, store path | T7 |

---

## Task 1: `mail-builder` dep + shared types + `build_mime` (text-only)

**Files:**
- Modify: `kylins.client.backend/Cargo.toml`
- Modify: `kylins.client.backend/src/mail/mod.rs` (add `pub mod builder;`)
- Create: `kylins.client.backend/src/mail/builder.rs`
- Test: `kylins.client.backend/src/mail/builder.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `pub struct SendDraft`, `pub struct AttachmentRef`, `pub struct AddressSpec`, `pub async fn build_mime(draft: &SendDraft) -> Result<Vec<u8>, String>`. Later tasks (T2 extends `build_mime`; T6/T7 produce `SendDraft`) consume these.

- [ ] **Step 1: Add the dependency**

Edit `kylins.client.backend/Cargo.toml` `[dependencies]`, add:
```toml
mail-builder = "0.4"
```

- [ ] **Step 2: Register the module**

In `kylins.client.backend/src/mail/mod.rs`, add alongside the existing `pub mod ...;` lines:
```rust
pub mod builder;
```

- [ ] **Step 3: Write the failing test**

Create `kylins.client.backend/src/mail/builder.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AddressSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub file_path: String,
    pub filename: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SendDraft {
    pub draft_id: String,
    pub from: AddressSpec,
    pub to: Vec<AddressSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cc: Vec<AddressSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bcc: Vec<AddressSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<AddressSpec>,
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html_body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inline_images: Vec<AttachmentRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_headers: Vec<(String, String)>,
}

/// Build an RFC5322 message from a structured draft. Text-only in T1;
/// extended (html/inline/attachments/headers) in T2.
pub async fn build_mime(draft: &SendDraft) -> Result<Vec<u8>, String> {
    let mut b = mail_builder::MessageBuilder::new();
    b = address_header_from(b, draft.from.clone(), |bb, a| bb.from(a));
    b = address_header_from(b, draft.to.clone(), |bb, a| bb.to(a));
    if !draft.cc.is_empty() {
        b = address_header_from(b, draft.cc.clone(), |bb, a| bb.cc(a));
    }
    if !draft.bcc.is_empty() {
        b = address_header_from(b, draft.bcc.clone(), |bb, a| bb.bcc(a));
    }
    if let Some(rt) = draft.reply_to.clone() {
        b = b.from(address(rt)); // placeholder — see note below; replaced in Step 4
    }
    b = b.subject(draft.subject.clone());
    if let Some(text) = &draft.text_body {
        b = b.text_body(text.clone());
    }
    b.write_to_vec().map_err(|e| format!("mime build failed: {e}"))
}

fn address(a: AddressSpec) -> mail_builder::headers::address::Address {
    mail_builder::headers::address::Address::new_address(a.name.unwrap_or_default(), a.email)
}

/// Apply a list of addresses to a header builder via the given method.
/// (Helper shape — finalize exact generics in Step 4 once the Address API is confirmed.)
fn address_header_from<F>(
    mut b: mail_builder::MessageBuilder<'_>,
    addrs: Vec<AddressSpec>,
    _set: F,
) -> mail_builder::MessageBuilder<'_>
where
    F: Fn(mail_builder::MessageBuilder<'_>, mail_builder::headers::address::Address) -> mail_builder::MessageBuilder<'_>,
{
    for a in addrs {
        b = b.from(address(a)); // placeholder wiring — corrected in Step 4
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_parser::MessageParser;

    fn addr(email: &str) -> AddressSpec {
        AddressSpec { name: None, email: email.into() }
    }

    #[tokio::test]
    async fn builds_text_only_message() {
        let draft = SendDraft {
            draft_id: "t1".into(),
            from: addr("alice@kylins.local"),
            to: vec![addr("bob@kylins.local")],
            subject: "Hello".into(),
            text_body: Some("plain body".into()),
            ..Default::default()
        };
        let bytes = build_mime(&draft).await.unwrap();
        let parsed = MessageParser::default().parse(&bytes).expect("parse");
        assert_eq!(parsed.subject().unwrap(), "Hello");
        assert_eq!(parsed.body_text(0).unwrap(), "plain body");
        assert_eq!(parsed.from().unwrap().first().unwrap().addr(), "alice@kylins.local");
        assert_eq!(parsed.to().unwrap().first().unwrap().addr(), "bob@kylins.local");
    }
}
```

**Note (Step 3 → 4):** the `address_header_from` helper above is intentionally a placeholder. mail-builder's `.from/.to/.cc/.bcc` each take `impl Into<Address<'x>>` where a `Vec<Address>` is accepted (group/multi). The exact path is `mail_builder::headers::address::Address` — **confirm the type path and the multi-recipient form in docs.rs/mail-builder 0.4.4** before finalizing. The test is what matters here; the helper just needs to produce a parseable message.

- [ ] **Step 4: Run the test to verify it fails (compile)**

Run (from `kylins.client.backend/`): `cargo test --lib builder::tests::builds_text_only_message`
Expected: compile error (placeholder wiring / Address path). Use the error to fix the `address_header_from` + `address` helpers to the real mail-builder 0.4.4 API. The target: `.from(address(draft.from))`, `.to(vec![address(...), ...])`, etc.

- [ ] **Step 5: Implement to make the test pass**

Fix the helpers so `build_mime` compiles and the test passes. Replace the placeholder `from` misuse for `reply_to`/`cc`/`bcc`/`to` with the correct methods (`.reply_to`, `.to`, `.cc`, `.bcc`). For a single address use `.from(address(one))`; for a list, pass `Vec<Address>`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test --lib builder::tests::builds_text_only_message`
Expected: PASS.

- [ ] **Step 7: Controller review gate**

`cargo clippy --all-targets -- -D warnings` clean. Controller reviews: type definitions match spec §"Structured draft", serde camelCase, no `unwrap()` in production path (only tests). **Do not commit.** Record ledger entry: `T1 mail-builder dep + types + build_mime(text) — DONE (uncommitted)`.

---

## Task 2: `build_mime` full — alternative/related/mixed, inline, attachments, headers, threading

**Files:**
- Modify: `kylins.client.backend/src/mail/builder.rs`

**Interfaces:**
- Consumes: T1 types + `build_mime`.
- Produces: `build_mime` now honors `html_body`/`text_body` (multipart/alternative), `inline_images` (multipart/related via `.inline`), `attachments` (multipart/mixed via `.attachment`), `extra_headers` (`.header`), `in_reply_to`/`references`.

- [ ] **Step 1: Add the failing tests**

Append to `builder.rs` `#[cfg(test)] mod tests`:
```rust
fn fixture_html_draft() -> SendDraft {
    SendDraft {
        draft_id: "t2".into(),
        from: addr("alice@kylins.local"),
        to: vec![addr("bob@kylins.local")],
        subject: "Html".into(),
        text_body: Some("plain".into()),
        html_body: Some("<p>Html <img src=\"cid:logo@kylins.mail\"/></p>".into()),
        inline_images: vec![AttachmentRef {
            file_path: "/nonexistent/inline.png".into(), // replaced in test via tmp file
            filename: "logo.png".into(),
            mime_type: "image/png".into(),
            cid: Some("logo@kylins.mail".into()),
        }],
        ..Default::default()
    }
}

#[tokio::test]
async fn builds_multipart_alternative_when_html_and_text() {
    let mut draft = fixture_html_draft();
    draft.inline_images.clear();
    let bytes = build_mime(&draft).await.unwrap();
    let s = String::from_utf8(bytes).unwrap();
    assert!(s.contains("multipart/alternative"));
    assert!(s.contains("plain"));
    assert!(s.contains("<p>Html"));
}

#[tokio::test]
async fn builds_related_for_inline_cid_image() {
    // write a tiny PNG to a temp file so build_mime can read it
    let dir = std::env::temp_dir();
    let path = dir.join("t2_inline.png");
    std::fs::write(&path, &[1u8, 2, 3, 4]).unwrap();
    let mut draft = fixture_html_draft();
    draft.inline_images[0].file_path = path.to_string_lossy().into_owned();
    let bytes = build_mime(&draft).await.unwrap();
    let s = String::from_utf8(bytes).unwrap();
    assert!(s.contains("multipart/related"), "related part missing");
    assert!(s.contains("Content-ID: <logo@kylins.mail>"), "cid missing");
    std::fs::remove_file(&path).ok();
}

#[tokio::test]
async fn builds_mixed_for_attachment() {
    let path = std::env::temp_dir().join("t2_attach.bin");
    std::fs::write(&path, b"attachment bytes").unwrap();
    let draft = SendDraft {
        draft_id: "t2b".into(),
        from: addr("a@kylins.local"),
        to: vec![addr("b@kylins.local")],
        subject: "Att".into(),
        text_body: Some("body".into()),
        attachments: vec![AttachmentRef {
            file_path: path.to_string_lossy().into_owned(),
            filename: "file.bin".into(),
            mime_type: "application/octet-stream".into(),
            cid: None,
        }],
        ..Default::default()
    };
    let s = String::from_utf8(build_mime(&draft).await.unwrap()).unwrap();
    assert!(s.contains("multipart/mixed"), "mixed missing");
    assert!(s.contains("filename=\"file.bin\""));
    std::fs::remove_file(&path).ok();
}

#[tokio::test]
async fn applies_custom_headers_and_threading() {
    let draft = SendDraft {
        draft_id: "t2c".into(),
        from: addr("a@kylins.local"),
        to: vec![addr("b@kylins.local")],
        subject: "Re: Hi".into(),
        text_body: Some("x".into()),
        in_reply_to: Some("<orig@kylins.mail>".into()),
        references: vec!["<orig@kylins.mail>".into()],
        extra_headers: vec![("X-Priority".into(), "1".into())],
        ..Default::default()
    };
    let s = String::from_utf8(build_mime(&draft).await.unwrap()).unwrap();
    assert!(s.contains("In-Reply-To: <orig@kylins.mail>"));
    assert!(s.contains("References: <orig@kylins.mail>"));
    assert!(s.contains("X-Priority: 1"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib builder::tests`
Expected: the new tests fail (html/inline/attach/headers not yet handled).

- [ ] **Step 3: Extend `build_mime`**

In `builder.rs`, after the text-only body, extend `build_mime`:
```rust
// custom headers
for (k, v) in &draft.extra_headers {
    b = b.header(k.clone(), v.clone());
}
// threading
if let Some(irt) = &draft.in_reply_to {
    b = b.in_reply_to(irt.clone());
}
if !draft.references.is_empty() {
    b = b.references(draft.references.clone());
}
// html body (multipart/alternative auto-built when both text+html set)
if let Some(html) = &draft.html_body {
    b = b.html_body(html.clone());
}
// inline images (Content-ID) -> multipart/related auto-built
for img in &draft.inline_images {
    let bytes = tokio::fs::read(&img.file_path)
        .await
        .map_err(|e| format!("read inline {}: {e}", img.file_path))?;
    let cid = img.cid.clone().unwrap_or_default();
    b = b.inline(img.mime_type.clone(), cid, bytes);
}
// attachments -> multipart/mixed auto-built
for att in &draft.attachments {
    let bytes = tokio::fs::read(&att.file_path)
        .await
        .map_err(|e| format!("read attachment {}: {e}", att.file_path))?;
    b = b.attachment(att.mime_type.clone(), att.filename.clone(), bytes);
}
```
(Place these before `b.write_to_vec()`. `mail-builder` auto-structures alternative/related/mixed based on which of `text_body`/`html_body`/`inline`/`attachment` are set — verify ordering with the tests.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib builder::tests`
Expected: all PASS.

- [ ] **Step 5: Controller review gate**

`cargo clippy --all-targets -- -D warnings` clean. Confirm: multipart structure matches spec §"Why mail-builder"; inline `cid:` produces `multipart/related` + `Content-ID`; attachment produces `multipart/mixed` + `filename`; no plaintext body lost when html set. **Do not commit.** Ledger: `T2 build_mime full (alt/related/mixed/inline/attach/headers/threading) — DONE (uncommitted)`.

---

## Task 3: `MailSource::send(&[u8])` + `Capabilities.saves_sent_automatically` + SMTP/IMAP/EAS signatures

**Files:**
- Modify: `sync_engine/mod.rs` (Capabilities + trait `send`)
- Modify: `mail/smtp/client.rs` (`send_raw_email` takes `&[u8]`)
- Modify: `sync_engine/imap_source.rs` (`send`, `capabilities`)
- Modify: `sync_engine/eas_source.rs` (`send` signature + `capabilities`; body stays `nyi()` until T5)
- Modify: `sync_engine/mock_source.rs` (`send` signature)
- Modify: `db/mutations.rs` (`exec_via_source` Send arm: decode base64url → bytes → `send(&[u8])` — **temporary bridge** until T6 swaps to structured draft)

**Interfaces:**
- Produces: `MailSource::send(&self, raw_mime: &[u8])`, `Capabilities { saves_sent_automatically: bool, .. }`. The `exec_via_source` Send arm still consumes `raw_base64url` (string) for now — it decodes to bytes and calls the new `send(&[u8])`. This keeps the frontend contract unchanged until T6.

- [ ] **Step 1: `Capabilities` — add the field**

`sync_engine/mod.rs`:
```rust
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct Capabilities {
    pub idle: bool,
    pub condstore: bool,
    pub qresync: bool,
    pub ping: bool,
    pub vanishearch: bool,
    /// True when the server stores a Sent copy as part of send (EAS SaveInSentItems,
    /// Gmail/Graph auto-save). False when the client must IMAP-APPEND to Sent (IMAP/SMTP).
    pub saves_sent_automatically: bool,
}
```
(Default stays all-false; no other change to the derive.)

- [ ] **Step 2: Trait `send` — change signature**

`sync_engine/mod.rs`, the `MailSource` trait:
```rust
async fn send(&self, raw_mime: &[u8]) -> Result<(), SourceError>;
```

- [ ] **Step 3: SMTP client — take bytes**

`mail/smtp/client.rs`, change:
```rust
pub async fn send_raw_email(
    config: &SmtpConfig,
    raw_email_base64url: &str,
) -> Result<SmtpSendResult, String>
```
to:
```rust
pub async fn send_raw_email(
    config: &SmtpConfig,
    raw_email: &[u8],
) -> Result<SmtpSendResult, String>
```
Remove the base64url-decode line that previously produced the bytes; use `raw_email` directly for the lettre `send_raw` call. Keep everything else.

- [ ] **Step 4: IMAP source**

`sync_engine/imap_source.rs`:
```rust
async fn send(&self, raw_mime: &[u8]) -> Result<(), SourceError> {
    crate::mail::smtp::client::send_raw_email(&self.smtp_config, raw_mime)
        .await
        .map_err(SourceError::Transport)?;
    Ok(())
}
```
(Adjust the `SourceError` variant to whichever the existing code used — check the current `send` body at `imap_source.rs:1133` and preserve its error mapping.)
`capabilities()`: add `saves_sent_automatically: false` to the returned struct.

- [ ] **Step 5: EAS source (signature + caps only; wiring in T5)**

`sync_engine/eas_source.rs`:
```rust
async fn send(&self, _raw_mime: &[u8]) -> Result<(), SourceError> {
    Err(crate::sync_engine::nyi()) // implemented in T5
}
```
`capabilities()`: add `saves_sent_automatically: true` (EAS `SaveInSentItems` will save).

- [ ] **Step 6: Mock source**

`sync_engine/mock_source.rs`: change `send` signature to `&[u8]` (store/use bytes as the existing mock does).

- [ ] **Step 7: `exec_via_source` — temporary base64url bridge**

`db/mutations.rs`, the Send arm (currently `MutationOp::Send { raw_base64url } => src.send(raw_base64url).await,`):
```rust
MutationOp::Send { raw_base64url } => {
    let bytes = base64url_decode(&raw_base64url)
        .map_err(|e| SourceError::Transport(format!("base64url decode: {e}")))?;
    src.send(&bytes).await
}
```
Add/locate a `base64url_decode` helper (the codebase already decodes base64url somewhere — grep for an existing one; if none, use the `base64` crate already in the dependency tree with `URL_SAFE_NO_PAD`). **This bridge is removed in T6** when `MutationOp::Send` becomes `{ draft }`.

- [ ] **Step 8: Fix any other `send` callers + tests**

Grep `src/` for `.send(` and `raw_base64url` to find every call site + test that constructs a Send op. Update them to pass `&[u8]` (for direct `send` calls) — the `MutationOp::Send` construction still takes a `raw_base64url: String` for now (frontend unchanged). Run: `grep -rn "raw_base64url\|\.send(" kylins.client.backend/src` (via the Grep tool) and fix each.

- [ ] **Step 9: Build + test**

Run: `cargo test --lib` (from backend dir).
Expected: all PASS. (IMAP send path now round-trips base64url → bytes → SMTP.)

- [ ] **Step 10: Controller review gate**

`cargo clippy --all-targets -- -D warnings` clean. Confirm: `Capabilities` field added to all three impls (Imap false, EAS true, Mock default); SMTP client takes `&[u8]`; the temporary bridge is clearly marked. **Do not commit.** Ledger: `T3 send(&[u8]) + Capabilities.saves_sent_automatically + SMTP/IMAP/EAS sigs — DONE (uncommitted)`.

---

## Task 4: EAS WBXML — fix tag bug + raw-bytes `<Mime>` OPAQUE + golden test

**Files:**
- Modify: `eas/commands.rs` (tag constants, `SendMailRequest`, `build_send_mail_request`, `parse_send_mail_response`)
- Test: `eas/commands.rs` (fix `send_mail_request_round_trips`, add golden-bytes test)

**Interfaces:**
- Produces: `SendMailRequest { mime: Vec<u8>, save_to_sent: bool, client_id: Option<String> }`, `build_send_mail_request` emitting `<Mime>` as WBXML OPAQUE. Consumed by `client.send_mail` (T5 wires `EasSource::send`).

**Background (from spec §"EAS SendMail" + audit):** the local aliases `CM_MIME=0x09`, `CM_REPLACE_MIME=0x0E`, `CM_STATUS=0x18` are WRONG. Correct values (already in `eas/wbxml/tags.rs` `tags::compose`): `MIME=0x10`, `REPLACE_MIME=0x09`, `STATUS=0x12`, `SAVE_IN_SENT_ITEMS=0x08`, `CLIENT_ID=0x11`, `SEND_MAIL=0x05`. The serializer's `opaque(&[u8])` writes `0xC3` + mb_u_int32(len) + raw bytes — this is how `<Mime>` must be emitted (raw RFC822 bytes, NOT base64).

- [ ] **Step 1: Delete the wrong local aliases**

`eas/commands.rs` around lines 97-107 — delete:
```rust
const CM_MIME: u8 = 0x09;          // WRONG
const CM_REPLACE_MIME: u8 = 0x0E;  // WRONG
const CM_STATUS: u8 = 0x18;        // WRONG
```
(Keep `CM_SEND_MAIL`, `CM_SMART_FORWARD`, `CM_SMART_REPLY`, `CM_SAVE_IN_SENT`, `CM_SOURCE`, `CM_FOLDER_ID`, `CM_ITEM_ID` if used — but prefer using `tags::compose::*` directly. Simplest: delete ALL the local `CM_*` aliases and use `crate::eas::wbxml::tags::compose::*` everywhere in this file.)

- [ ] **Step 2: Change `SendMailRequest` to raw bytes**

In `eas/commands.rs` (find the `SendMailRequest` struct definition):
```rust
#[derive(Debug, Clone)]
pub struct SendMailRequest {
    /// Raw RFC822 message bytes (emitted as a WBXML OPAQUE `<Mime>` element).
    pub mime: Vec<u8>,
    pub save_to_sent: bool,
    /// Client-generated correlation id, e.g. "SendMail-{uuid}".
    pub client_id: Option<String>,
}
```

- [ ] **Step 3: Rewrite `build_send_mail_request`**

`eas/commands.rs`:
```rust
use crate::eas::wbxml::tags::compose::{SEND_MAIL, SAVE_IN_SENT_ITEMS, MIME, CLIENT_ID};
use crate::eas::wbxml::code_pages::PAGE_COMPOSE; // confirm the exact const name in code_pages.rs

pub fn build_send_mail_request(req: &SendMailRequest) -> WbxmlElement {
    let mut children = vec![];
    if let Some(cid) = &req.client_id {
        children.push(WbxmlElement::text(PAGE_COMPOSE, CLIENT_ID, cid.clone()));
    }
    if req.save_to_sent {
        children.push(WbxmlElement::empty(PAGE_COMPOSE, SAVE_IN_SENT_ITEMS));
    }
    children.push(WbxmlElement::opaque(PAGE_COMPOSE, MIME, req.mime.clone()));
    WbxmlElement::container(PAGE_COMPOSE, SEND_MAIL, children)
}
```
**Verify** the `WbxmlElement` API in `eas/wbxml/`: does it have `opaque(page, token, bytes)`? If not, use whatever the serializer path is (the serializer's `opaque(&[u8])` exists; `WbxmlElement` may need an `Opaque` variant or a builder). If `WbxmlElement` has no opaque variant, add one that serializes via the existing `serializer.opaque(...)`. This is the load-bearing change — confirm against `eas/wbxml/serializer.rs` + the `WbxmlElement` enum.

- [ ] **Step 4: Fix `parse_send_mail_response`**

In `eas/commands.rs`, wherever it reads the status token, change the token constant from the old `CM_STATUS` (0x18) to `tags::compose::STATUS` (0x12). Empty body / no `<Status>` = success (status 1).

- [ ] **Step 5: Update the existing round-trip test + add golden-bytes test**

`eas/commands.rs` tests:
```rust
#[test]
fn send_mail_request_emits_opaque_mime_with_correct_tokens() {
    let raw_mime = b"From: a@b\r\nTo: c@d\r\nSubject: t\r\n\r\nbody\r\n";
    let req = SendMailRequest {
        mime: raw_mime.to_vec(),
        save_to_sent: true,
        client_id: Some("SendMail-1234".into()),
    };
    let el = build_send_mail_request(&req);
    let wbxml = crate::eas::wbxml::serialize(&el).expect("serialize"); // confirm serialize fn name
    // 1. The raw MIME bytes appear verbatim in the WBXML (inside the OPAQUE block),
    //    NOT base64-encoded. This is the regression guard.
    assert!(wbxml.windows(raw_mime.len()).any(|w| w == raw_mime),
        "raw MIME must be present verbatim (opaque), not base64");
    // 2. The MIME token byte 0x10 (not the buggy 0x09) precedes the OPAQUE marker 0xC3.
    let mime_token = 0xC3u8; // OPAQUE marker
    let idx = wbxml.iter().position(|&b| b == mime_token).expect("opaque marker");
    // token byte just before the page+token should reference 0x10; assert the page-token pair exists
    assert!(wbxml.windows(2).any(|w| w[1] == 0xC3),
        "expected a token followed by OPAQUE marker");
    // 3. SaveInSentItems (0x08) and ClientId (0x11) tokens present
    assert!(wbxml.contains(&0x08), "SaveInSentItems token 0x08 missing");
    assert!(wbxml.contains(&0x11), "ClientId token 0x11 missing");
}
```
Update `send_mail_request_round_trips` to construct `SendMailRequest { mime, save_to_sent, client_id }` (raw bytes, not base64 text).

- [ ] **Step 6: Run tests**

Run: `cargo test --lib send_mail` (from backend dir).
Expected: PASS — golden test confirms raw bytes + correct tokens.

- [ ] **Step 7: Controller review gate**

`cargo clippy --all-targets -- -D warnings` clean. Confirm: no remaining `CM_MIME=0x09`/`CM_STATUS=0x18` aliases; `<Mime>` is OPAQUE raw bytes (golden test); `SaveInSentItems` empty-tag + `ClientId` present. **Do not commit.** Ledger: `T4 EAS WBXML tag-bug fix + opaque Mime + golden test — DONE (uncommitted)`.

---

## Task 5: EAS `recovery_action_for_send_mail` + `EasSource::send` wiring

**Files:**
- Modify: `eas/status.rs` (new classifier)
- Modify: `sync_engine/eas_source.rs` (real `send`)
- Test: `eas/status.rs` (classifier tests)

**Interfaces:**
- Consumes: T3 `send(&[u8])` signature; T4 `client.send_mail` + `SendMailRequest`.
- Produces: a working EAS send path (`capabilities().saves_sent_automatically = true` already set in T3).

- [ ] **Step 1: Add the classifier (test-first)**

`eas/status.rs` tests:
```rust
#[test]
fn send_mail_status_maps_provisioning_retry_auth_fatal() {
    use crate::eas::status::{recovery_action_for_send_mail, RecoveryAction};
    assert_eq!(recovery_action_for_send_mail(140), RecoveryAction::NeedsProvision);
    assert_eq!(recovery_action_for_send_mail(142), RecoveryAction::NeedsProvision);
    assert_eq!(recovery_action_for_send_mail(111), RecoveryAction::Retry);
    assert_eq!(recovery_action_for_send_mail(132), RecoveryAction::Retry);
    assert_eq!(recovery_action_for_send_mail(130), RecoveryAction::FatalAuth);
    assert_eq!(recovery_action_for_send_mail(131), RecoveryAction::FatalAuth);
}
```
(Confirm the exact `RecoveryAction` variant names from `eas/status.rs`; the audit lists 9 variants — align the test to the real names.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib recovery_action_for_send_mail`
Expected: FAIL (function missing).

- [ ] **Step 3: Implement the classifier**

`eas/status.rs`, modeled on the existing `recovery_action_for_*` classifiers:
```rust
pub fn recovery_action_for_send_mail(status: u32) -> RecoveryAction {
    match status {
        140 | 141 | 142 | 143 | 144 => RecoveryAction::NeedsProvision, // adjust to real variants
        111 | 132 => RecoveryAction::Retry,
        130 | 131 => RecoveryAction::FatalAuth,
        _ => RecoveryAction::FatalOther, // unknown -> do not retry blindly
    }
}
```
(Adapt variant names to the real enum. Mirror the structure of `recovery_action_for_sync`.)

- [ ] **Step 4: Run classifier test to verify pass**

Run: `cargo test --lib recovery_action_for_send_mail`
Expected: PASS.

- [ ] **Step 5: Wire `EasSource::send`**

`sync_engine/eas_source.rs`, replace the `nyi()` body:
```rust
async fn send(&self, raw_mime: &[u8]) -> Result<(), SourceError> {
    use crate::eas::{client::EasClient, commands::SendMailRequest};
    let mut client = EasClient::from_account(&self.account, &self.pool).await
        .map_err(|e| SourceError::Transport(format!("eas client: {e}")))?; // confirm the real ctor
    let req = SendMailRequest {
        mime: raw_mime.to_vec(),
        save_to_sent: true,
        client_id: Some(format!("SendMail-{}", uuid::Uuid::new_v4())),
    };
    client.send_mail(&req).await
        .map(|_| ())
        .map_err(SourceError::from) // confirm EasError->SourceError From impl; add if missing
}
```
**Verify** against the real `EasSource` struct (holds `account` + `pool`; rebuilds the client per call — see `eas_source.rs:78-90`) and the real `EasClient` constructor. If `EasError` does not yet have a `From<EasError> for SourceError`, add one (or map variants explicitly: `Transport`, `HttpStatus`, `CommandStatus`). The 3b status classifiers are reused inside `client.send_command` (retry/provision/auth-refresh already happen there).

- [ ] **Step 6: Build + test**

Run: `cargo test --lib` (from backend dir).
Expected: PASS. (EAS send now builds a real `SendMail` request; full transport is exercised at manual e2e in T9 since there's no test Exchange box.)

- [ ] **Step 7: Controller review gate**

`cargo clippy --all-targets -- -D warnings` clean. Confirm: classifier covers provisioning/retry/fatal-auth; `EasSource::send` builds `SendMailRequest` with raw bytes + `save_to_sent=true` + `client_id`; reuses the 3b `send_command` retry layer (no hand-rolled HTTP). **Do not commit.** Ledger: `T5 EAS send_mail classifier + EasSource.send wiring — DONE (uncommitted)`.

---

## Task 6: Backend IPC contract — `MutationOp::Send { draft }` + engine build-and-send

**Files:**
- Modify: `db/mutations.rs` (`Send { draft: SendDraft }`; remove Send arm from `exec_via_source`)
- Modify: `sync_engine/engine.rs` (`run_replay_round` — special-case Send: build → send; no append yet)
- Test: `sync_engine/engine.rs` (Send op drives build_mime + send via a mock source)

**Interfaces:**
- Consumes: T1/T2 `build_mime` + `SendDraft`; T3 `send(&[u8])`.
- Produces: `MutationOp::Send { draft: SendDraft }` over IPC (the frontend `send.ts` switches to `{ type:'send', draft }` in T7). **Between T6 and T7 the live app is mid-migration** (frontend still sends `rawBase64url`); automated tests stay green because they mock `invoke`. T7 restores the live app.

- [ ] **Step 1: Change the `MutationOp::Send` variant**

`db/mutations.rs`:
```rust
#[serde(rename_all = "camelCase")]
Send { draft: crate::mail::builder::SendDraft },
```
Remove the temporary base64url-decode bridge added in T3 (the `raw_base64url` field is gone).

- [ ] **Step 2: Remove the Send arm from `exec_via_source`**

`db/mutations.rs` `exec_via_source`: delete the `MutationOp::Send { .. } => ...` arm. The Send op is now handled directly by the replay worker (Step 3). (If Rust complains the match is non-exhaustive, add `MutationOp::Send { .. } => Err(SourceError::Transport("Send handled by replay worker".into())),` as an unreachable fallback.)

- [ ] **Step 3: Handle Send in the replay worker**

`sync_engine/engine.rs` `run_replay_round` — inside the `for op in ops` loop, before `exec_via_source`:
```rust
let mop = match MutationOp::from_pending(&op) { ... };

let outcome = match &mop {
    MutationOp::Send { draft } => {
        send_op(engine, src, draft).await // build + send (+ append in T8)
    }
    _ => mop.exec_via_source(src).await,
};
// then the existing Ok/Err -> mark_completed/mark_failed handling, unchanged
```
Add the helper (same file):
```rust
async fn send_op(
    engine: &Arc<SyncEngine>,
    src: &dyn MailSource,
    draft: &crate::mail::builder::SendDraft,
) -> Result<(), SourceError> {
    let mime = crate::mail::builder::build_mime(draft)
        .await
        .map_err(|e| SourceError::Transport(format!("build_mime: {e}")))?;
    src.send(&mime).await // T8 adds best-effort append + cleanup here
}
```

- [ ] **Step 4: Write the engine test**

`sync_engine/engine.rs` tests (use `MockSource`):
```rust
#[tokio::test]
async fn send_op_builds_mime_and_calls_send() {
    let mock = MockSource::default(); // confirm ctor; it should capture sent bytes
    let draft = crate::mail::builder::SendDraft {
        draft_id: "e1".into(),
        from: crate::mail::builder::AddressSpec { name: None, email: "a@b".into() },
        to: vec![crate::mail::builder::AddressSpec { name: None, email: "c@d".into() }],
        subject: "s".into(),
        text_body: Some("body".into()),
        ..Default::default()
    };
    // build a minimal SyncEngine + call send_op (or factor send_op to take only src + draft)
    // assert: mock.last_sent_bytes() contains "Subject: s" and "body"
}
```
(If `send_op` is private and hard to reach, factor the core logic into a testable `pub(crate) async fn build_and_send(src, draft)` and have `send_op` call it. The test asserts the built MIME is passed to `src.send`.)

- [ ] **Step 5: Build + test**

Run: `cargo test --lib` (backend dir).
Expected: PASS. Backend now consumes `{ type:'send', draft }`.

- [ ] **Step 6: Controller review gate**

`cargo clippy --all-targets -- -D warnings` clean. Confirm: `MutationOp::Send` carries `SendDraft`; `exec_via_source` no longer sends; the replay worker builds MIME then sends; the build error path returns a `SourceError` (so it retries/permanent-fails correctly). **Note the live-app mid-migration window until T7.** **Do not commit.** Ledger: `T6 backend MutationOp::Send{draft} + engine build-and-send — DONE (uncommitted; frontend in T7)`.

---

## Task 7: Frontend send path — path-based attachments + `buildSendDraft` + `send.ts`

**Files:**
- Create: `services/composer/types.ts`, `services/composer/buildSendDraft.ts`, `services/composer/attachments.ts`
- Modify: `services/composer/send.ts`, `services/composer/drafts.ts` (`DraftInput.attachments` → path-based)
- Modify: `utils/emailBuilder.ts` (keep `htmlToPlainText` + `extractInlineImages`; remove `buildRawEmail` + base64/multipart)
- Modify: *(composer attachment picker — locate via grep of `attachments`/attachment dialog usage)*
- Test: `tests/services/composer/buildSendDraft.test.ts`, update `tests/services/composer/send.test.ts`

**Interfaces:**
- Consumes: T6 backend contract `{ type:'send', draft }`.
- Produces: end-to-end send from the composer with file-backed attachments (no base64 over IPC). After T7 the live app is whole again.

**Background:** the composer currently stores attachments as base64 `content` in `DraftInput.attachments` (see `utils/emailBuilder.ts` `EmailAttachment`). For large sends this must become file-backed: the picker copies the file to `<appData>/outbox-attachments/{draftId}/{filename}` and stores the **path**. `buildSendDraft` produces the `SendDraft` Rust consumes; inline images (data: URLs in HTML) are extracted and written to files with `cid:` refs, matching the existing `extractInlineImages` logic.

- [ ] **Step 1: TS types**

Create `services/composer/types.ts`:
```ts
export interface AddressSpec {
  name?: string;
  email: string;
}
export interface AttachmentRef {
  filePath: string;
  filename: string;
  mimeType: string;
  cid?: string;
}
export interface SendDraft {
  draftId: string;
  from: AddressSpec;
  to: AddressSpec[];
  cc?: AddressSpec[];
  bcc?: AddressSpec[];
  replyTo?: AddressSpec;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: AttachmentRef[];
  inlineImages?: AttachmentRef[];
  extraHeaders?: Array<[string, string]>;
}
```

- [ ] **Step 2: Attachment staging helpers**

Create `services/composer/attachments.ts`:
```ts
import { appDataDir, join } from '@tauri-apps/api/path';
import { copyFile, mkdir, remove, exists, writeTextFile } from '@tauri-apps/plugin-fs';
import { v4 as uuid } from 'uuid'; // if uuid is a dep; else crypto.randomUUID()

export function newDraftId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36));
}

export async function outboxDir(draftId: string): Promise<string> {
  return join(await appDataDir(), 'outbox-attachments', draftId);
}

/** Copy a picked source file into the draft's outbox; return the dest path. */
export async function stageAttachment(draftId: string, srcPath: string, filename: string): Promise<string> {
  const dir = await outboxDir(draftId);
  await mkdir(dir, { recursive: true });
  const dest = await join(dir, filename);
  await copyFile(srcPath, dest);
  return dest;
}

/** Write inline image bytes (base64 from a data: URL) to a file; return path. */
export async function stageInlineImage(draftId: string, cid: string, mimeType: string): Promise<{ path: string; filename: string; mimeType: string }> {
  const dir = await outboxDir(draftId);
  await mkdir(dir, { recursive: true });
  const ext = mimeType.split('/')[1] ?? 'bin';
  const filename = `${cid.replace(/[^a-zA-Z0-9_.-]/g, '_')}.${ext}`;
  const dest = await join(dir, filename);
  // write the decoded bytes — caller passes base64; decode + write as binary via a small helper
  return { path: dest, filename, mimeType };
}

export async function cleanupAttachments(draftId: string): Promise<void> {
  const dir = await outboxDir(draftId);
  if (await exists(dir)) await remove(dir);
}
```
**Verify** the `@tauri-apps/api/path` + `@tauri-apps/plugin-fs` APIs are the installed versions; confirm `copyFile`/`mkdir`/`remove`/`exists` exist (check `package.json` + node_modules). The base64→binary write needs a `writeFile`/`BinaryFile` helper from the fs plugin — use it in `stageInlineImage`.

- [ ] **Step 3: `DraftInput.attachments` → path-based**

`services/composer/drafts.ts`: change `DraftInput.attachments` element type from `{ filename; mimeType; content: string }` to `{ filename; mimeType; filePath: string }`. **Audit the composer attachment picker** (grep for where a file is picked and `content:` base64 is produced) and change it to call `stageAttachment(draftId, pickedPath, filename)` and store `{ filename, mimeType, filePath }`. Also audit `drafts.ts` persistence: if attachments are persisted in the drafts table as base64, store the path instead (the file already lives in app-data).

- [ ] **Step 4: `buildSendDraft`**

Create `services/composer/buildSendDraft.ts`:
```ts
import { appDataDir, join } from '@tauri-apps/api/path';
import { writeFile, mkdir } from '@tauri-apps/plugin-fs';
import { inlineCss } from './juiceInline';
import { stripSignature } from '@/features/composer/signaturePlacement';
import { formatRecipients } from '@/features/composer/contacts';
import { htmlToPlainText, extractInlineImages } from '@/utils/emailBuilder';
import { stageInlineImage, outboxDir } from './attachments';
import type { AddressSpec, AttachmentRef, SendDraft } from './types';
import type { DraftInput } from './drafts';

function toAddr(email: string): AddressSpec { return { email }; }

export async function buildSendDraft(
  input: DraftInput,
  draftId: string,
  fallbackFrom: string,
): Promise<SendDraft> {
  const preparedHtml = stripSignature(inlineCss(input.bodyHtml));
  const { html, images } = extractInlineImages(preparedHtml);

  const inlineImages: AttachmentRef[] = [];
  let finalHtml = html;
  for (const img of images) {
    const staged = await stageInlineImageInline(draftId, img.cid, img.mimeType, img.base64);
    inlineImages.push({ filePath: staged.path, filename: staged.filename, mimeType: staged.mimeType, cid: img.cid });
  }

  const attachments: AttachmentRef[] = (input.attachments ?? []).map((a) => ({
    filePath: a.filePath, filename: a.filename, mimeType: a.mimeType,
  }));

  const extraHeaders: Array<[string, string]> = [];
  if (input.extraHeaders) for (const [k, v] of Object.entries(input.extraHeaders)) extraHeaders.push([k, v]);
  if (input.importance && input.importance !== 'normal') {
    extraHeaders.push(['X-Priority', input.importance === 'high' ? '1' : '5']);
    extraHeaders.push(['Importance', input.importance]);
  }
  if (input.requestReadReceipt) extraHeaders.push(['Disposition-Notification-To', input.fromEmail ?? fallbackFrom]);
  if (input.preventCopy) extraHeaders.push(['X-Classification-Prevent-Copy', 'true']);

  return {
    draftId,
    from: toAddr(input.fromEmail ?? fallbackFrom),
    to: formatRecipients(input.to).map(toAddr),
    cc: input.cc && input.cc.length ? formatRecipients(input.cc).map(toAddr) : undefined,
    bcc: input.bcc && input.bcc.length ? formatRecipients(input.bcc).map(toAddr) : undefined,
    replyTo: input.replyTo && input.replyTo.length ? toAddr(formatRecipients(input.replyTo)[0]) : undefined,
    subject: input.subject,
    htmlBody: finalHtml,
    textBody: htmlToPlainText(finalHtml),
    inReplyTo: input.inReplyToMessageId ?? undefined,
    references: undefined,
    attachments: attachments.length ? attachments : undefined,
    inlineImages: inlineImages.length ? inlineImages : undefined,
    extraHeaders: extraHeaders.length ? extraHeaders : undefined,
  };
}

// helper: decode base64 + write to file under the draft outbox
async function stageInlineImageInline(draftId: string, cid: string, mimeType: string, base64: string) {
  const staged = await stageInlineImage(draftId, cid, mimeType);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const dir = await outboxDir(draftId);
  await mkdir(dir, { recursive: true });
  const dest = await join(dir, staged.filename);
  await writeFile(dest, bytes);
  return { path: dest, filename: staged.filename, mimeType };
}
```
**Note:** `formatRecipients` returns address strings; mapping `.map(toAddr)` turns each into `{ email }`. Confirm `formatRecipients` returns `string[]`; if it returns structured objects, adapt. Confirm `input.references` doesn't exist on `DraftInput` (only `inReplyToMessageId`) — if threading needs `References`, leave `undefined` for now.

- [ ] **Step 5: Update `send.ts`**

`services/composer/send.ts` — replace the `buildRawEmail` + `{ type:'send', rawBase64url }` path:
```ts
import { buildSendDraft } from './buildSendDraft';
import { newDraftId } from './attachments';
// remove the buildRawEmail import

export async function sendEmail(accountId: string, input: DraftInput, draftId?: string | null): Promise<SendResult> {
  const account = useAccountStore.getState().accounts.find((a) => a.id === accountId);
  if (!account) return { success: false, message: `No account found for id ${accountId}` };

  const sendDraftId = draftId ?? newDraftId();
  const draft = await buildSendDraft(input, sendDraftId, account.email);

  try {
    await invoke('sync_apply_mutation', { accountId, op: { type: 'send', draft } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message };
  }
  if (draftId) await deleteDraft(draftId);
  window.dispatchEvent(new Event(SEND_COMPLETE_EVENT));
  return { success: true, message: 'Queued for send' };
}
```
Delete the now-unused `inputToEmailDraft` helper.

- [ ] **Step 6: Trim `emailBuilder.ts`**

`utils/emailBuilder.ts`: **delete** `buildRawEmail`, `base64UrlEncode`, `buildAlternativePart`, `EmailAttachment`, `EmailDraft` types, `generateMessageId`. **Keep** `htmlToPlainText` and `extractInlineImages` (export both — `buildSendDraft` uses them). Update the file header comment.

- [ ] **Step 7: Fix import fallout**

Grep `src/` for `buildRawEmail` and `EmailAttachment`/`EmailDraft` references (via Grep tool) and fix/remove each. The composer picker (Step 3) is the main one.

- [ ] **Step 8: Tests**

Update `tests/services/composer/send.test.ts` to assert the invoke payload is `{ type:'send', draft }` (not `rawBase64url`). Mock `buildSendDraft`'s fs deps (`@tauri-apps/plugin-fs`, `@tauri-apps/api/path`). Add `tests/services/composer/buildSendDraft.test.ts` asserting: html+text produced, inline data: URL → `inlineImages` ref with cid + the HTML rewritten to `cid:`, importance/read-receipt/preventCopy → `extraHeaders`, attachments → `attachments` refs with `filePath`.

Run: `npx vitest run tests/services/composer` (frontend dir).
Expected: PASS.

- [ ] **Step 9: Type-check + full frontend tests**

Run: `npx tsc --noEmit` then `npx vitest run` (frontend dir).
Expected: clean + PASS.

- [ ] **Step 10: Controller review gate**

Full tree compiles, `cargo test --lib` + frontend `vitest` green, `cargo clippy --all-targets -- -D warnings` clean. **Live app whole again.** Confirm: no base64 crosses IPC; attachments are paths; `emailBuilder.ts` no longer builds MIME. **Do not commit.** Ledger: `T7 frontend path-based attachments + buildSendDraft + send.ts{draft} — DONE (uncommitted)`.

---

## Task 8: Engine best-effort Sent-append + `save_sent_copy` + cleanup

**Files:**
- Modify: `sync_engine/engine.rs` (`send_op` — add append + cleanup)
- Modify: `db/labels.rs` (`resolve_sent_folder`)
- Test: `sync_engine/engine.rs` (append called for IMAP when !saves_sent && save_sent_copy; not for EAS; append failure doesn't fail the op; cleanup runs on success)

**Interfaces:**
- Consumes: T6 `send_op`; `db::labels::get_folder_by_role`; `db::settings::get_bool`.
- Produces: sent messages appear in the Sent folder for IMAP/SMTP accounts; attachments cleaned up on success.

- [ ] **Step 1: `resolve_sent_folder`**

`db/labels.rs`:
```rust
/// Resolve the account's Sent folder. Preference: special_use/role == "sent"
/// (via get_folder_by_role); else None (caller logs + skips the append).
pub async fn resolve_sent_folder(
    pool: &SqlitePool,
    account_id: &str,
) -> Result<Option<MailFolder>, String> {
    let f = get_folder_by_role(pool, account_id, "sent").await?;
    Ok(f)
}
```
(The `sent_folder_path` settings-override + conventional-name fallbacks from the spec are optional refinements — wire `get_folder_by_role` first; add the override only if a test/account needs it. Document the fallback in a comment.)

- [ ] **Step 2: Extend `send_op` with append + cleanup**

`sync_engine/engine.rs`, the `send_op` helper from T6:
```rust
async fn send_op(
    engine: &Arc<SyncEngine>,
    src: &dyn MailSource,
    draft: &crate::mail::builder::SendDraft,
) -> Result<(), SourceError> {
    let mime = crate::mail::builder::build_mime(draft).await
        .map_err(|e| SourceError::Transport(format!("build_mime: {e}")))?;

    src.send(&mime).await?; // the retryable unit

    // best-effort Sent-append (IMAP/SMTP only). NEVER fails the op.
    if !src.capabilities().saves_sent_automatically {
        if let Ok(Some(save)) = save_sent_copy(&engine.pool, /* account_id */ ).await {
            if save {
                match crate::db::labels::resolve_sent_folder(&engine.pool, /* account_id */ ).await {
                    Ok(Some(folder)) => {
                        if let Err(e) = src.append(&folder.remote(), &mime, &["\\Seen"]).await {
                            log::warn!("[sync] sent-append failed (best-effort, send already succeeded): {e}");
                        }
                    }
                    Ok(None) => log::warn!("[sync] sent-append skipped: no Sent folder for account"),
                    Err(e) => log::warn!("[sync] sent-append skipped: resolve error {e}"),
                }
            }
        }
    }

    // cleanup staged attachments (best-effort)
    if let Err(e) = cleanup_attachment_files(&draft.draft_id).await {
        log::warn!("[sync] attachment cleanup failed for {}: {e}", draft.draft_id);
    }
    Ok(())
}

async fn save_sent_copy(pool: &SqlitePool, account_id: &str) -> Result<Option<bool>, String> {
    crate::db::settings::get_bool(pool, &format!("account.{account_id}.save_sent_copy")).await
}

async fn cleanup_attachment_files(draft_id: &str) -> Result<(), String> {
    // <appData>/outbox-attachments/{draft_id}
    let base = dirs::data_dir().ok_or("no appData dir")?; // or tauri's app_data_dir via a handle
    let dir = base.join("mailclient").join("outbox-attachments").join(draft_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```
**Verify** (a) `account_id` — it's available on the `op`/`engine` context; thread it into `send_op` from `run_replay_round` (the loop knows `account_id`). (b) `MailFolder.remote()` — confirm the method that converts `MailFolder` → `RemoteFolder` (or use `folder_remote` from `db/mutations.rs`). (c) The appData path — prefer the Tauri `app_data_dir` resolver the backend already uses (grep for `app_data_dir`/`PathResolver`); avoid adding the `dirs` crate if Tauri provides it. (d) `src.append` signature is `(&RemoteFolder, &[u8], &[&str])`.

- [ ] **Step 3: Tests**

`sync_engine/engine.rs` tests using `MockSource` with `with_caps`:
```rust
#[tokio::test]
async fn send_op_appends_for_imap_when_save_sent() {
    // mock caps: saves_sent_automatically=false; capture append() calls
    // assert append called once with &[\\Seen] after send
}
#[tokio::test]
async fn send_op_skips_append_for_eas() {
    // mock caps: saves_sent_automatically=true; assert append NOT called
}
#[tokio::test]
async fn send_op_append_failure_does_not_fail_op() {
    // mock: append returns Err; send returns Ok -> send_op returns Ok
}
#[tokio::test]
async fn send_op_cleans_up_attachments_on_success() {
    // stage a temp dir; assert removed after send_op Ok
}
```
(Use `MockSource::with_caps(...)` + a way to inspect `append` calls — extend `MockSource` if needed to record calls.)

- [ ] **Step 4: Run tests**

Run: `cargo test --lib send_op` (backend dir).
Expected: PASS.

- [ ] **Step 5: Controller review gate**

`cargo clippy --all-targets -- -D warnings` clean. Confirm: append is best-effort (warning, never fails op); gated by `!saves_sent_automatically && save_sent_copy`; cleanup runs on success; EAS path skips append. **Do not commit.** Ledger: `T8 engine best-effort Sent-append + save_sent_copy + cleanup — DONE (uncommitted)`.

---

## Task 9: Verification — end-to-end send + receive, large attachment, offline/retry

**Files:** none (verification + ledger/memory updates).

**Interfaces:** n/a.

- [ ] **Step 1: Backend gates**

Run (backend dir): `cargo test --lib` and `cargo clippy --all-targets -- -D warnings`.
Expected: all green.

- [ ] **Step 2: Frontend gates**

Run (frontend dir): `npx tsc --noEmit` and `npx vitest run`.
Expected: clean + green.

- [ ] **Step 3: Real IMAP/SMTP send + receive**

Test creds: `felixzhou@kylins.local`, `imap.kylins.com` / `smtp.kylins.com`, STARTTLS, accept invalid certs (see memory `test-imap-smtp-server`).
- Compose + send to self (or a second account) with a **>100 MB attachment**. Confirm: SMTP transport succeeds; the Sent APPEND lands (Sent folder shows the message); receive (IDLE/poll) picks it up in Inbox; peak memory stays bounded (no OOM).
- Send a reply (confirm `In-Reply-To`/`References` threading).
- Send with inline image (confirm `cid:` renders in the received message).
- Disable `save_sent_copy` for the account → confirm no Sent copy.

- [ ] **Step 4: EAS WBXML confidence**

The T4 golden-bytes test is the automated gate (no test Exchange box). If a real Exchange account is available, also do a live EAS send; otherwise defer to the pending 3a/3b manual EAS e2e.

- [ ] **Step 5: Offline/retry + best-effort append**

- Disconnect network → send → confirm the row queues (`status='pending'`) → reconnect → confirm backoff-driven retry succeeds → `mark_completed` → attachment files deleted.
- Force an IMAP APPEND failure (e.g. read-only Sent) after a successful SMTP send → confirm the send is still `mark_completed` + a warning is emitted (no duplicate send).

- [ ] **Step 6: Update memory + ledger**

Record results in the project memory (`composer-viewer-calendar-progress.md` or a new `send-flow-hardening.md`) + the SDD ledger. Note: large-send verified on real server; EAS send WBXML-verified (live Exchange deferred); follow-ups (SmartReply/SmartForward, near-zero-memory streaming, Gmail/Graph send in 3c/3d).

- [ ] **Step 7: Controller final review**

Full tree green; manual e2e passed; memory/ledger updated. **Do not commit** — surface the completed, uncommitted changeset to the user for their review/commit decision. Ledger: `T9 verification (IMAP/SMTP real e2e incl >100MB, offline/retry, best-effort append; EAS golden; clippy/tsc/vitest) — DONE (uncommitted; awaiting user commit)`.

---

## Self-review (controller runs before handing off)

1. **Spec coverage:** every spec section maps to a task — mail-builder (T1-T2), `send(&[u8])` + Capabilities (T3), EAS WBXML + tag bug (T4), EAS wiring + classifier (T5), `MutationOp::Send{draft}` + engine (T6), frontend path-based attachments + buildSendDraft (T7), Sent-append + save_sent_copy + cleanup (T8), large-send + e2e verification (T9). SmartReply/SmartForward, near-zero-memory streaming, Gmail/Graph send are documented future (not tasks). ✓
2. **Placeholder scan:** every code step has real code; `Verify…` notes flag exact-API confirmations (mail-builder Address, WbxmlElement.opaque, MockSource ctor) the implementer resolves against docs.rs/source — not placeholders, but explicit verification steps for crate-version-sensitive signatures. ✓
3. **Type consistency:** `SendDraft`/`AttachmentRef`/`AddressSpec` field names match across Rust (serde camelCase) and TS (`filePath`, `draftId`, `mimeType`, `inlineImages`, `extraHeaders`). `MutationOp::Send { draft }` ↔ frontend `{ type:'send', draft }`. `send(&[u8])` consistent T3→T8. ✓
4. **No-commit rule:** Global Constraints + every review gate say "Do not commit." ✓
5. **Ordering risk:** the T6→T7 live-app window is explicit; automated tests stay green throughout. ✓
