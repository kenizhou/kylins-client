// Outbound MIME building via Stalwart `mail-builder`.
//
// Send-flow hardening T1: text-only message building + shared serde types
// (`SendDraft` / `AttachmentRef` / `AddressSpec`). T2 extends `build_mime`
// to honor html_body / inline_images / attachments / extra_headers / threading.

use mail_builder::{
    headers::{address::Address, raw::Raw as RawHeader, message_id::MessageId},
    mime::{BodyPart, MimePart},
    MessageBuilder,
};
use serde::{Deserialize, Serialize};

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

    if inline_parts.is_empty() {
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
        // multipart/mixed (and include the text alternative if present).
        let top: MimePart<'_> = if !attach_parts.is_empty() {
            let mut mixed_children: Vec<MimePart<'_>> =
                Vec::with_capacity(2 + attach_parts.len());
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
            mixed_children.extend(attach_parts);
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

/// Push a pre-built attachment `MimePart` onto the builder by extracting its
/// content-type, filename, and body. mail-builder 0.4.4's `.attachment(...)`
/// takes `(content_type, filename, body)` separately, so we decompose here.
fn push_attachment<'x>(b: MessageBuilder<'x>, part: MimePart<'x>) -> MessageBuilder<'x> {
    let content_type = extract_content_type(&part).unwrap_or_else(|| "application/octet-stream".to_string());
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
    use mail_parser::MessageParser;

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
        let parsed = MessageParser::default()
            .parse(&bytes)
            .expect("parse");
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
}
