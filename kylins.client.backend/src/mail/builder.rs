// Outbound MIME building via Stalwart `mail-builder`.
//
// Send-flow hardening T1: text-only message building + shared serde types
// (`SendDraft` / `AttachmentRef` / `AddressSpec`). T2 extends `build_mime`
// to honor html_body / inline_images / attachments / extra_headers / threading.

use mail_builder::{
    headers::{address::Address, message_id::MessageId, raw::Raw as RawHeader},
    mime::{BodyPart, MimePart},
    MessageBuilder,
};
use serde::{Deserialize, Serialize};

use crypto_core::envelope::EncryptionGranularity;

/// RFC5322 address — single recipient/sender. `name` is the display name.
/// Field names are camelCase over IPC (matches the TS `AddressSpec`).
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AddressSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub email: String,
}

/// Reference to a file-backed attachment (regular or inline).
/// `file_path` is absolute, under `<appData>/outbox-attachments/{draftId}/`.
/// `cid` is `Some` only for inline_images (matches a `cid:` ref in `html_body`).
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub file_path: String,
    pub filename: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
}

/// Per-message crypto intent carried in `SendDraft`. Mirrors the TS union
/// `'none' | 'smime'` (serde `rename_all = "lowercase"`). Future standards
/// (openpgp, sm) add variants here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CryptoMethod {
    #[default]
    None,
    Smime,
}

/// Structured draft crossing IPC as JSON. The frontend (`buildSendDraft`)
/// produces this; the backend builds RFC5322 bytes via `build_mime`.
///
/// T1 consumes `from`/`to`/`cc`/`bcc`/`reply_to`/`subject`/`text_body` only.
/// T2 will consume the remaining fields (html/inline/attachments/headers/threading).
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reply_to: Vec<AddressSpec>,
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
    /// S/MIME per-message intent (sign/encrypt toggles). Default `None` — the
    /// send path treats the draft as plain MIME. Plan 4a honors `Smime`.
    #[serde(default)]
    pub crypto_method: CryptoMethod,
    /// Sign the message (clear-sign multipart/signed). Only meaningful when
    /// `crypto_method == Smime`.
    #[serde(default)]
    pub sign: bool,
    /// Encrypt the message (application/pkcs7-mime enveloped-data).
    #[serde(default)]
    pub encrypt: bool,
}

/// Convert an `AddressSpec` into a `mail-builder` `Address` (owned, single-address form).
/// `Address::new_address` takes `Option<impl Into<Cow<'x, str>>>` for the name.
fn to_address(a: &AddressSpec) -> Address<'_> {
    Address::new_address(a.name.clone(), a.email.clone())
}

/// Convert a `Vec<AddressSpec>` into a `mail-builder` `Address::List` (owned).
/// Used for multi-recipient headers (To/Cc/Bcc).
fn to_address_list(addrs: &[AddressSpec]) -> Address<'_> {
    Address::new_list(addrs.iter().map(to_address).collect())
}

/// Build an RFC5322 message from a structured draft.
///
/// T1: text-only. T2: html/inline/attachments/extra_headers/threading.
///
/// **mail-builder 0.4.4 multipart behavior** (confirmed against source):
/// - `.text_body` + `.html_body` alone → auto-builds `multipart/alternative`.
/// - `.attachment` adds parts to a single internal `attachments` Vec; the top-level
///   structure is auto-built from `(text_body, html_body, attachments)` as one of:
///   `multipart/mixed` (when attachments present, wrapping alternative or a single
///   body), or `multipart/alternative` (text+html, no attachments), or just the body.
/// - `.inline(...)` does NOT auto-build `multipart/related` — it simply pushes a part
///   with `Content-Disposition: inline` + a `Content-ID` into the same `attachments`
///   Vec. RFC 2387 `multipart/related` (HTML body + embedded `cid:` images) must be
///   constructed manually via `.body(MimePart::new("multipart/related", ...))`. We do
///   that whenever `inline_images` is non-empty so HTML can reference the images by cid.
///
/// Errors are mapped to `String` so the caller (`engine.rs` `send_op`) can
/// surface them as a `SourceError::Transport(...)` without a bespoke enum.
pub async fn build_mime(draft: &SendDraft) -> Result<Vec<u8>, String> {
    build_mime_with_granularity(draft, EncryptionGranularity::WholeMessage).await
}

/// Build an RFC5322 message from a structured draft, composing the MIME tree
/// per the per-account `EncryptionGranularity` (§11.4.1 of the crypto arch doc).
///
/// Granularity A (`BodyInlineAndPerAttachment`) and `WholeMessage` produce
/// byte-identical output to the historical single-blob `build_mime` — on the
/// S/MIME A-form wire their per-part session-key benefit is collapsed
/// (realized only under future SplitPerPart). Granularity B
/// (`BodyInlineAndMergedAttachments`) composes a merged `multipart/mixed`
/// subtree containing all regular attachments (body+inline become one unit,
/// the merged attachment container becomes another) — but only when there are
/// ≥2 regular attachments; with <2 the tree is unchanged.
pub async fn build_mime_with_granularity(
    draft: &SendDraft,
    granularity: EncryptionGranularity,
) -> Result<Vec<u8>, String> {
    let mut b = MessageBuilder::new();

    // Address headers. `.from` takes a single Address; To/Cc/Bcc take a List.
    b = b.from(to_address(&draft.from));
    if !draft.to.is_empty() {
        b = b.to(to_address_list(&draft.to));
    }
    if !draft.cc.is_empty() {
        b = b.cc(to_address_list(&draft.cc));
    }
    if !draft.bcc.is_empty() {
        b = b.bcc(to_address_list(&draft.bcc));
    }
    if !draft.reply_to.is_empty() {
        b = b.reply_to(to_address_list(&draft.reply_to));
    }

    b = b.subject(draft.subject.clone());

    // Custom headers — e.g. importance (X-Priority / Importance), read-receipt
    // (Disposition-Notification-To), classification (X-Classification-Prevent-Copy).
    // `Raw` is used because mail-builder 0.4.4 has no `From<String> for HeaderType`;
    // `Raw: From<T: Into<Cow<str>>>` + `From<Raw> for HeaderType` is the path.
    for (k, v) in &draft.extra_headers {
        b = b.header(k.clone(), RawHeader::new(v.clone()));
    }

    // Threading. mail-builder's `MessageId::write_header` always wraps each id in
    // angle brackets, so strip any caller-supplied brackets to avoid `<<id>>`.
    if let Some(irt) = &draft.in_reply_to {
        b = b.in_reply_to(MessageId::new(strip_brackets(irt)));
    }
    // `MessageId` has a private `id: Vec<Cow>` with no public multi-value constructor,
    // but `.references(impl Into<MessageId>)` only takes one id anyway. RFC 5322 allows
    // a single-element References list (the immediate parent), which is what we emit.
    // A future hardening can thread the full chain via the parser-side `MessageId::new_list`.
    if let Some(first_ref) = draft.references.first() {
        b = b.references(MessageId::new(strip_brackets(first_ref)));
    }

    // Read inline image files (before deciding body structure).
    let mut inline_parts: Vec<MimePart<'_>> = Vec::with_capacity(draft.inline_images.len());
    for img in &draft.inline_images {
        let bytes = tokio::fs::read(&img.file_path)
            .await
            .map_err(|e| format!("read inline {}: {e}", img.file_path))?;
        let cid = img.cid.clone().unwrap_or_default();
        // mail-builder wraps the cid in `<...>` for the Content-ID header, so we
        // strip any caller-supplied brackets to keep `<{cid}>` well-formed.
        let cid_clean = strip_brackets(&cid);
        let part = MimePart::new(img.mime_type.clone(), BodyPart::Binary(bytes.into()))
            .inline()
            .cid(cid_clean);
        inline_parts.push(part);
    }

    // Read attachment files (regular, non-inline). Kept as (content_type, filename, bytes)
    // so we can route through MessageBuilder's `.attachment(...)` for the non-inline path
    // (lets mail-builder auto-structure alternative/mixed) and as `MimePart`s for the
    // inline path (where we build `multipart/related` manually and wrap everything).
    let mut attach_parts: Vec<MimePart<'_>> = Vec::with_capacity(draft.attachments.len());
    for att in &draft.attachments {
        let bytes = tokio::fs::read(&att.file_path)
            .await
            .map_err(|e| format!("read attachment {}: {e}", att.file_path))?;
        let part = MimePart::new(att.mime_type.clone(), BodyPart::Binary(bytes.into()))
            .attachment(att.filename.clone());
        attach_parts.push(part);
    }

    // Merge flag: Granularity B with ≥2 regular attachments. Otherwise the tree
    // is byte-identical to today (WholeMessage / A / B-with-<2-attachments).
    let merge = granularity == EncryptionGranularity::BodyInlineAndMergedAttachments
        && attach_parts.len() >= 2;

    if inline_parts.is_empty() {
        if merge {
            // Auto-structuring (.text_body/.html_body/.push_attachment) can't
            // express a nested container, so compose the tree by hand.
            let body_unit = body_unit_no_inline(draft);
            let merged = MimePart::new("multipart/mixed", BodyPart::Multipart(attach_parts));
            let top = MimePart::new(
                "multipart/mixed",
                BodyPart::Multipart(vec![body_unit, merged]),
            );
            b = b.body(top);
        } else {
            // No inline images → let mail-builder auto-structure text/html/attachments.
            // text+html → multipart/alternative; +attachments → multipart/mixed on top.
            if let Some(text) = &draft.text_body {
                b = b.text_body(text.clone());
            }
            if let Some(html) = &draft.html_body {
                b = b.html_body(html.clone());
            }
            for part in attach_parts {
                b = push_attachment(b, part);
            }
        }
    } else {
        // HTML references cid: images → wrap as RFC 2387 multipart/related.
        // mail-builder does not auto-build related, so we construct it manually.
        let html_part = MimePart::new(
            "text/html",
            BodyPart::Text(draft.html_body.clone().unwrap_or_default().into()),
        );
        let mut related_children: Vec<MimePart<'_>> = Vec::with_capacity(1 + inline_parts.len());
        related_children.push(html_part);
        related_children.extend(inline_parts);

        let related = MimePart::new("multipart/related", BodyPart::Multipart(related_children));

        // Compose the top-level body. If there are regular attachments, wrap in
        // multipart/mixed (and include the text alternative if present). On the
        // merge branch, the attachments are nested under a single merged
        // multipart/mixed child rather than siblings.
        let top: MimePart<'_> = if !attach_parts.is_empty() {
            let mut mixed_children: Vec<MimePart<'_>> =
                Vec::with_capacity(2 + if merge { 1 } else { attach_parts.len() });
            if let Some(text) = &draft.text_body {
                let text_part = MimePart::new("text/plain", BodyPart::Text(text.clone().into()));
                let alt = MimePart::new(
                    "multipart/alternative",
                    BodyPart::Multipart(vec![text_part, related]),
                );
                mixed_children.push(alt);
            } else {
                mixed_children.push(related);
            }
            if merge {
                mixed_children.push(MimePart::new(
                    "multipart/mixed",
                    BodyPart::Multipart(attach_parts),
                ));
            } else {
                mixed_children.extend(attach_parts);
            }
            MimePart::new("multipart/mixed", BodyPart::Multipart(mixed_children))
        } else if let Some(text) = &draft.text_body {
            // text + related → wrap in multipart/alternative so clients can pick.
            let text_part = MimePart::new("text/plain", BodyPart::Text(text.clone().into()));
            MimePart::new(
                "multipart/alternative",
                BodyPart::Multipart(vec![text_part, related]),
            )
        } else {
            related
        };

        b = b.body(top);
    }

    b.write_to_vec()
        .map_err(|e| format!("mime build failed: {e}"))
}

/// Build the body unit when there are no inline images: text/html/alternative
/// per what's present. Used only on the Granularity-B non-inline merge path
/// (where we compose the multipart/mixed tree by hand instead of letting
/// mail-builder auto-structure via `.text_body` / `.html_body`).
fn body_unit_no_inline<'x>(draft: &SendDraft) -> MimePart<'x> {
    let has_html = draft
        .html_body
        .as_deref()
        .filter(|h| !h.is_empty())
        .is_some();
    let has_text = draft
        .text_body
        .as_deref()
        .filter(|t| !t.is_empty())
        .is_some();
    match (has_text, has_html) {
        (true, true) => {
            let t = MimePart::new(
                "text/plain",
                BodyPart::Text(draft.text_body.clone().unwrap().into()),
            );
            let h = MimePart::new(
                "text/html",
                BodyPart::Text(draft.html_body.clone().unwrap().into()),
            );
            MimePart::new("multipart/alternative", BodyPart::Multipart(vec![t, h]))
        }
        (false, true) => MimePart::new(
            "text/html",
            BodyPart::Text(draft.html_body.clone().unwrap().into()),
        ),
        (true, false) => MimePart::new(
            "text/plain",
            BodyPart::Text(draft.text_body.clone().unwrap().into()),
        ),
        (false, false) => MimePart::new("text/plain", BodyPart::Text(String::new().into())),
    }
}

/// Push a pre-built attachment `MimePart` onto the builder by extracting its
/// content-type, filename, and body. mail-builder 0.4.4's `.attachment(...)`
/// takes `(content_type, filename, body)` separately, so we decompose here.
fn push_attachment<'x>(b: MessageBuilder<'x>, part: MimePart<'x>) -> MessageBuilder<'x> {
    let content_type =
        extract_content_type(&part).unwrap_or_else(|| "application/octet-stream".to_string());
    let filename = extract_filename(&part).unwrap_or_else(|| "attachment".to_string());
    let body = part.contents;
    b.attachment(content_type, filename, body)
}

/// Extract the content-type base string ("image/png") from a `MimePart`.
fn extract_content_type(part: &MimePart<'_>) -> Option<String> {
    for (name, value) in &part.headers {
        if name.eq_ignore_ascii_case("Content-Type") {
            if let mail_builder::headers::HeaderType::ContentType(ct) = value {
                return Some(ct.c_type.to_string());
            }
        }
    }
    None
}

/// Extract the `filename` parameter from a `MimePart`'s Content-Disposition.
fn extract_filename(part: &MimePart<'_>) -> Option<String> {
    for (name, value) in &part.headers {
        if name.eq_ignore_ascii_case("Content-Disposition") {
            if let mail_builder::headers::HeaderType::ContentType(ct) = value {
                for (attr, val) in &ct.attributes {
                    if attr.eq_ignore_ascii_case("filename") {
                        return Some(val.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Strip a single pair of surrounding `<...>` from a message-id / cid, if present.
/// mail-builder's `MessageId::write_header` re-adds angle brackets, so feeding it
/// an already-bracketed value would produce `<<id>>`.
fn strip_brackets(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2 && t.starts_with('<') && t.ends_with('>') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_parser::{MessageParser, MimeHeaders};

    fn addr(email: &str) -> AddressSpec {
        AddressSpec {
            name: None,
            email: email.into(),
        }
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
        assert_eq!(
            parsed.from().unwrap().first().unwrap().address().unwrap(),
            "alice@kylins.local"
        );
        assert_eq!(
            parsed.to().unwrap().first().unwrap().address().unwrap(),
            "bob@kylins.local"
        );
    }

    /// Shared draft with text + html + a (placeholder-path) inline image.
    /// Tests that need a real file rewrite `inline_images[0].file_path`.
    fn fixture_html_draft() -> SendDraft {
        SendDraft {
            draft_id: "t2".into(),
            from: addr("alice@kylins.local"),
            to: vec![addr("bob@kylins.local")],
            subject: "Html".into(),
            text_body: Some("plain".into()),
            html_body: Some("<p>Html <img src=\"cid:logo@kylins.mail\"/></p>".into()),
            inline_images: vec![AttachmentRef {
                file_path: "/nonexistent/inline.png".into(), // rewritten by tests
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
        std::fs::write(&path, [1u8, 2, 3, 4]).unwrap();
        let mut draft = fixture_html_draft();
        draft.inline_images[0].file_path = path.to_string_lossy().into_owned();
        let bytes = build_mime(&draft).await.unwrap();
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("multipart/related"), "related part missing");
        assert!(
            s.contains("Content-ID: <logo@kylins.mail>"),
            "cid missing or wrongly bracketed"
        );
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

    #[test]
    fn send_draft_crypto_fields_round_trip() {
        let draft = SendDraft {
            draft_id: "c1".into(),
            from: addr("a@k"),
            to: vec![addr("b@k")],
            subject: "S".into(),
            text_body: Some("x".into()),
            crypto_method: CryptoMethod::Smime,
            sign: true,
            encrypt: true,
            ..Default::default()
        };
        let json = serde_json::to_string(&draft).unwrap();
        assert!(json.contains("\"cryptoMethod\":\"smime\""), "{json}");
        assert!(json.contains("\"sign\":true"));
        assert!(json.contains("\"encrypt\":true"));
        let back: SendDraft = serde_json::from_str(&json).unwrap();
        assert_eq!(back.crypto_method, CryptoMethod::Smime);
        assert!(back.sign && back.encrypt);
    }

    #[test]
    fn send_draft_crypto_fields_default_none() {
        // `SendDraft` has `#[serde(rename_all = "camelCase")]`, so the JSON
        // keys must be camelCase. No crypto fields present → all default.
        let json = "{\"draftId\":\"\",\"from\":{\"email\":\"\"},\"to\":[],\"subject\":\"\"}";
        let d: SendDraft = serde_json::from_str(json).unwrap();
        assert_eq!(d.crypto_method, CryptoMethod::None);
        assert!(!d.sign && !d.encrypt);
    }

    /// Shared draft with text+html and 3 real (temp-file) regular attachments,
    /// no inline images. Used by the Granularity-B merge test and the
    /// WholeMessage/A byte-identical regression test. Writes temp files; callers
    /// must clean up `draft.attachments[*].file_path` when done.
    async fn make_three_attachment_draft() -> SendDraft {
        let dir = std::env::temp_dir();
        let p1 = dir.join("t4_a1.bin");
        let p2 = dir.join("t4_a2.bin");
        let p3 = dir.join("t4_a3.bin");
        std::fs::write(&p1, b"AAA").unwrap();
        std::fs::write(&p2, b"BBBB").unwrap();
        std::fs::write(&p3, b"CCCCC").unwrap();
        SendDraft {
            draft_id: "t4".into(),
            from: addr("a@kylins.local"),
            to: vec![addr("b@kylins.local")],
            subject: "Three attachments".into(),
            text_body: Some("plain body".into()),
            html_body: Some("<p>Html body</p>".into()),
            attachments: vec![
                AttachmentRef {
                    file_path: p1.to_string_lossy().into_owned(),
                    filename: "a1.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    cid: None,
                },
                AttachmentRef {
                    file_path: p2.to_string_lossy().into_owned(),
                    filename: "a2.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    cid: None,
                },
                AttachmentRef {
                    file_path: p3.to_string_lossy().into_owned(),
                    filename: "a3.bin".into(),
                    mime_type: "application/octet-stream".into(),
                    cid: None,
                },
            ],
            ..Default::default()
        }
    }

    /// Helper: assert the root part of `parsed` is multipart/mixed and return
    /// its child indices. Mirrors the traversal pattern in
    /// `mail/imap/client.rs::extract_attachments` (line ~3334) — uses
    /// `message.parts[0]` + `part.content_type()` + `PartType::Multipart`.
    fn root_mixed_children(parsed: &mail_parser::Message) -> Vec<usize> {
        use mail_parser::PartType;
        let root = parsed.parts.first().expect("parsed message has no parts");
        let ct = root.content_type().expect("root content-type");
        assert_eq!(ct.ctype(), "multipart", "root ctype");
        assert_eq!(ct.subtype(), Some("mixed"), "root subtype");
        match &root.body {
            PartType::Multipart(children) => children.clone(),
            _ => panic!("root part is not multipart"),
        }
    }

    /// Structural signature of a parsed MIME tree: a string like
    /// `mixed[alt[text/html]leaf[application/octet-stream]leaf[...]]`.
    /// Used to compare two trees for shape+content-type equality without
    /// comparing bytes (mail_builder 0.4.4 emits a random Message-ID and
    /// multipart boundary per call, so byte-equality across two `build_mime`
    /// invocations is impossible even for identical structure).
    fn structural_signature(parsed: &mail_parser::Message) -> String {
        use mail_parser::PartType;
        fn walk(parts: &[mail_parser::MessagePart], idx: usize) -> String {
            let part = match parts.get(idx) {
                Some(p) => p,
                None => return "?".to_string(),
            };
            let ct_str = part
                .content_type()
                .map(|ct| format!("{}/{}", ct.ctype(), ct.subtype().unwrap_or("")))
                .unwrap_or_else(|| "?".to_string());
            match &part.body {
                PartType::Multipart(children) => {
                    let inner: String = children
                        .iter()
                        .map(|&c| walk(parts, c))
                        .collect::<Vec<_>>()
                        .join("");
                    format!("{ct_str}[{inner}]")
                }
                _ => format!("leaf[{ct_str}]"),
            }
        }
        walk(&parsed.parts, 0)
    }

    #[tokio::test]
    async fn build_mime_granularity_b_merges_attachments() {
        let draft = make_three_attachment_draft().await;
        let bytes = build_mime_with_granularity(
            &draft,
            EncryptionGranularity::BodyInlineAndMergedAttachments,
        )
        .await
        .unwrap();
        let parsed = MessageParser::default().parse(&bytes).expect("parse");

        // Root: multipart/mixed with exactly 2 children (body unit + merged container).
        let root_children = root_mixed_children(&parsed);
        assert_eq!(
            root_children.len(),
            2,
            "top mixed should have 2 children (body + merged container)"
        );

        // Second child: multipart/mixed holding all 3 attachments.
        use mail_parser::PartType;
        let merged_idx = root_children[1];
        let merged = &parsed.parts[merged_idx];
        let merged_ct = merged.content_type().expect("merged content-type");
        assert_eq!(merged_ct.ctype(), "multipart");
        assert_eq!(merged_ct.subtype(), Some("mixed"));
        let merged_children = match &merged.body {
            PartType::Multipart(c) => c.clone(),
            _ => panic!("merged container is not multipart"),
        };
        assert_eq!(
            merged_children.len(),
            3,
            "merged container should hold 3 attachments"
        );

        // mail_parser's `attachments` index list should also report all 3.
        assert_eq!(parsed.attachments.len(), 3);

        for att in &draft.attachments {
            std::fs::remove_file(&att.file_path).ok();
        }
    }

    #[tokio::test]
    async fn build_mime_whole_and_a_produce_identical_structure() {
        let draft = make_three_attachment_draft().await;
        let whole = build_mime_with_granularity(&draft, EncryptionGranularity::WholeMessage)
            .await
            .unwrap();
        let a =
            build_mime_with_granularity(&draft, EncryptionGranularity::BodyInlineAndPerAttachment)
                .await
                .unwrap();

        let parsed_whole = MessageParser::default().parse(&whole).expect("parse whole");
        let parsed_a = MessageParser::default().parse(&a).expect("parse a");

        // Structural signature ignores random Message-ID / multipart boundary
        // strings (which mail_builder regenerates each call) and compares only
        // the tree shape + per-part content-types. WholeMessage and
        // Granularity A must produce the same structure: top multipart/mixed
        // with 4 children (alt(text,html) + 3 sibling attachments), no merged
        // container.
        assert_eq!(
            structural_signature(&parsed_whole),
            structural_signature(&parsed_a),
            "WholeMessage and BodyInlineAndPerAttachment must produce structurally identical MIME"
        );

        // Both must have 4 top-mixed children (body unit + 3 sibling attachments).
        assert_eq!(root_mixed_children(&parsed_whole).len(), 4);
        assert_eq!(root_mixed_children(&parsed_a).len(), 4);
        // Both must report 3 attachments via mail_parser.
        assert_eq!(parsed_whole.attachments.len(), 3);
        assert_eq!(parsed_a.attachments.len(), 3);

        for att in &draft.attachments {
            std::fs::remove_file(&att.file_path).ok();
        }
    }
}
