// ImapSource — MailSource adapter over the existing async-imap client.
//
// Owns its connection lifecycle (connect once per public call, run sub-ops on the same
// session, logout at the end). Maps ImapFolder -> RemoteFolder and ImapMessage ->
// RemoteMessage. sync_folder uses delta semantics: get_folder_status for UIDVALIDITY,
// fetch_new_uids(highest_uid+1), chunked fetch_messages for the new envelopes.
//
// CAPABILITY negotiation is deferred to Phase 2 (it only matters for selecting the IDLE
// real-time strategy; Phase 0 polls regardless, so capabilities() returns the default
// poll-only set for now).

use async_trait::async_trait;

use crate::db::accounts::Account;
use crate::mail::imap::client as imap_client;
use crate::mail::imap::types::{ImapConfig, ImapFolder, ImapMessage};
use crate::mail::smtp::client as smtp_client;
use crate::mail::smtp::types::SmtpConfig;

use super::{Capabilities, Cursor, FolderDelta, MailSource, RemoteFolder, RemoteMessage, SourceError};

pub struct ImapSource {
    account: Account,
}

impl ImapSource {
    pub fn new(account: Account) -> Self {
        Self { account }
    }

    fn imap_config(&self) -> ImapConfig {
        ImapConfig {
            host: self.account.imap_host.clone().unwrap_or_default(),
            port: self.account.imap_port.unwrap_or(993) as u16,
            security: self.account.imap_security.clone().unwrap_or_else(|| "tls".to_string()),
            username: self.account.imap_username.clone().unwrap_or_else(|| self.account.email.clone()),
            password: self.account.imap_password.clone().unwrap_or_default(),
            auth_method: self.account.auth_method.clone().unwrap_or_else(|| "password".to_string()),
            accept_invalid_certs: self.account.accept_invalid_certs,
        }
    }

    fn smtp_config(&self) -> SmtpConfig {
        SmtpConfig {
            host: self.account.smtp_host.clone().unwrap_or_default(),
            port: self.account.smtp_port.unwrap_or(587) as u16,
            security: self.account.smtp_security.clone().unwrap_or_else(|| "starttls".to_string()),
            username: self.account.imap_username.clone().unwrap_or_else(|| self.account.email.clone()),
            password: self.account.imap_password.clone().unwrap_or_default(),
            auth_method: self.account.auth_method.clone().unwrap_or_else(|| "password".to_string()),
            accept_invalid_certs: self.account.accept_invalid_certs,
        }
    }
}

fn other(e: String) -> SourceError {
    SourceError::Other(e)
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",")
}

fn format_flags(flags: &[&str]) -> String {
    format!(
        "({})",
        flags
            .iter()
            .map(|f| if f.starts_with('\\') { (*f).to_string() } else { format!("\\{f}") })
            .collect::<Vec<_>>()
            .join(" ")
    )
}

fn role_from_special_use(su: Option<&str>) -> Option<String> {
    let s = su?.to_ascii_lowercase();
    if s.contains("inbox") {
        Some("inbox".into())
    } else if s.contains("\\sent") {
        Some("sent".into())
    } else if s.contains("\\drafts") {
        Some("drafts".into())
    } else if s.contains("\\trash") {
        Some("trash".into())
    } else if s.contains("\\junk") || s.contains("\\spam") {
        Some("junk".into())
    } else if s.contains("\\archive") || s.contains("\\all") {
        Some("archive".into())
    } else {
        None
    }
}

fn role_from_name(name: &str) -> Option<String> {
    if name.eq_ignore_ascii_case("inbox") {
        Some("inbox".into())
    } else {
        None
    }
}

fn parent_of(path: &str, delimiter: &str) -> Option<String> {
    if delimiter.is_empty() {
        return None;
    }
    let parts: Vec<&str> = path.split(delimiter).collect();
    if parts.len() > 1 {
        Some(parts[..parts.len() - 1].join(delimiter))
    } else {
        None
    }
}

fn imap_folder_to_remote(f: ImapFolder) -> RemoteFolder {
    let remote_id = if f.raw_path.is_empty() { f.path.clone() } else { f.raw_path.clone() };
    // parent_id must be computed from the SAME source as remote_id so it
    // matches the parent's remote_id column. Using decoded path would produce
    // mismatched values for non-ASCII (IMAP modified UTF-7) names.
    let parent_id = parent_of(&remote_id, &f.delimiter);
    let role = role_from_special_use(f.special_use.as_deref()).or_else(|| role_from_name(&f.name));
    RemoteFolder {
        remote_id,
        name: f.name,
        delimiter: f.delimiter,
        special_use: f.special_use,
        role,
        parent_id,
        exists: f.exists,
        unseen: f.unseen,
    }
}

fn imap_message_to_remote(m: ImapMessage) -> RemoteMessage {
    let has_attachments = !m.attachments.is_empty();
    RemoteMessage {
        uid: m.uid,
        folder: m.folder,
        message_id: m.message_id,
        in_reply_to: m.in_reply_to,
        references: m.references,
        from_address: m.from_address,
        from_name: m.from_name,
        to_addresses: m.to_addresses,
        cc_addresses: m.cc_addresses,
        bcc_addresses: m.bcc_addresses,
        reply_to: m.reply_to,
        subject: m.subject,
        snippet: m.snippet,
        date: m.date,
        is_read: m.is_read,
        is_starred: m.is_starred,
        is_draft: m.is_draft,
        body_html: m.body_html,
        body_text: m.body_text,
        raw_size: m.raw_size,
        list_unsubscribe: m.list_unsubscribe,
        list_unsubscribe_post: m.list_unsubscribe_post,
        auth_results: m.auth_results,
        has_attachments,
    }
}

#[async_trait]
impl MailSource for ImapSource {
    fn capabilities(&self) -> Capabilities {
        // Phase 0: poll-only. CAPABILITY negotiation (idle/condstore/qresync) is Phase 2.
        Capabilities::default()
    }

    async fn list_folders(&self) -> Result<Vec<RemoteFolder>, SourceError> {
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        let folders = imap_client::list_folders(&mut session).await.map_err(other)?;
        let _ = session.logout().await;
        Ok(folders.into_iter().map(imap_folder_to_remote).collect())
    }

    async fn sync_folder(
        &self,
        folder: &RemoteFolder,
        since: Cursor,
    ) -> Result<FolderDelta, SourceError> {
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;

        let (since_uv, since_high) = match since {
            Cursor::Imap { uidvalidity, highest_uid, .. } => (uidvalidity, highest_uid),
            _ => (0, 0),
        };

        let status = imap_client::get_folder_status(&mut session, &folder.remote_id)
            .await
            .map_err(other)?;

        // UIDVALIDITY change -> the server rebuilt the folder; signal a cache wipe and a
        // full resync from uid 0. The engine (Task 8) deletes the folder's rows first.
        if since_uv != 0 && status.uidvalidity != since_uv {
            return Ok(FolderDelta {
                added: vec![],
                updated: vec![],
                vanished_uids: vec![],
                next_cursor: Cursor::Imap {
                    uidvalidity: status.uidvalidity,
                    highest_uid: 0,
                    highest_modseq: status.highest_modseq.unwrap_or(0),
                },
                uidvalidity_changed: true,
            });
        }

        let new_uids = imap_client::fetch_new_uids(&mut session, &folder.remote_id, since_high)
            .await
            .map_err(other)?;
        let to_fetch: Vec<u32> = new_uids.into_iter().filter(|&u| u > since_high).collect();

        let mut added = Vec::new();
        for chunk in to_fetch.chunks(100) {
            let range = uid_set(chunk);
            let res = match imap_client::fetch_messages(&mut session, &folder.remote_id, &range).await {
                Ok(r) => r,
                Err(e) if e.starts_with("ASYNC_IMAP_EMPTY:") => {
                    log::info!("[sync] async-imap returned empty; falling back to raw TCP fetch for {} UIDs {range}", folder.remote_id);
                    imap_client::raw_fetch_messages(&config, &folder.remote_id, &range)
                        .await
                        .map_err(other)?
                }
                Err(e) => return Err(other(e)),
            };
            for m in res.messages {
                added.push(imap_message_to_remote(m));
            }
        }

        let new_high = added.iter().map(|m| m.uid).max().unwrap_or(since_high);
        let _ = session.logout().await;

        Ok(FolderDelta {
            added,
            updated: vec![],
            vanished_uids: vec![],
            next_cursor: Cursor::Imap {
                uidvalidity: status.uidvalidity,
                highest_uid: new_high,
                highest_modseq: status.highest_modseq.unwrap_or(0),
            },
            uidvalidity_changed: false,
        })
    }

    async fn fetch_body(&self, folder: &RemoteFolder, uid: u32) -> Result<Option<String>, SourceError> {
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        let msg = imap_client::fetch_message_body(&mut session, &folder.remote_id, uid)
            .await
            .map_err(other)?;
        let _ = session.logout().await;
        Ok(msg.body_html.or(msg.body_text))
    }

    async fn set_flags(&self, folder: &RemoteFolder, uids: &[u32], flag: &str, add: bool) -> Result<(), SourceError> {
        if uids.is_empty() {
            return Ok(());
        }
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        let flag_op = if add { "+FLAGS" } else { "-FLAGS" };
        let flags_str = format_flags(&[flag]);
        imap_client::set_flags(&mut session, &folder.remote_id, &uid_set(uids), flag_op, &flags_str)
            .await
            .map_err(other)?;
        let _ = session.logout().await;
        Ok(())
    }

    async fn move_messages(&self, src: &RemoteFolder, uids: &[u32], dest: &RemoteFolder) -> Result<(), SourceError> {
        if uids.is_empty() {
            return Ok(());
        }
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        imap_client::move_messages(&mut session, &src.remote_id, &uid_set(uids), &dest.remote_id)
            .await
            .map_err(other)?;
        let _ = session.logout().await;
        Ok(())
    }

    async fn delete_messages(&self, folder: &RemoteFolder, uids: &[u32]) -> Result<(), SourceError> {
        if uids.is_empty() {
            return Ok(());
        }
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        imap_client::delete_messages(&mut session, &folder.remote_id, &uid_set(uids))
            .await
            .map_err(other)?;
        let _ = session.logout().await;
        Ok(())
    }

    async fn append(&self, folder: &RemoteFolder, raw: &[u8], flags: &[&str]) -> Result<(), SourceError> {
        let config = self.imap_config();
        let mut session = imap_client::connect(&config).await.map_err(other)?;
        let flags_str = format_flags(flags);
        let flags_opt = if flags.is_empty() { None } else { Some(flags_str.as_str()) };
        imap_client::append_message(&mut session, &folder.remote_id, flags_opt, raw)
            .await
            .map_err(other)?;
        let _ = session.logout().await;
        Ok(())
    }

    async fn send(&self, raw_base64url: &str) -> Result<(), SourceError> {
        smtp_client::send_raw_email(&self.smtp_config(), raw_base64url)
            .await
            .map(|_| ())
            .map_err(other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::imap::types::ImapAttachment;

    #[test]
    fn role_from_special_use_maps_known_flags() {
        assert_eq!(role_from_special_use(Some("\\Inbox")), Some("inbox".into()));
        assert_eq!(role_from_special_use(Some("\\Sent")), Some("sent".into()));
        assert_eq!(role_from_special_use(Some("\\Drafts")), Some("drafts".into()));
        assert_eq!(role_from_special_use(Some("\\Trash")), Some("trash".into()));
        assert_eq!(role_from_special_use(Some("\\Junk")), Some("junk".into()));
        assert_eq!(role_from_special_use(Some("\\Archive")), Some("archive".into()));
        assert_eq!(role_from_special_use(None), None);
        assert_eq!(role_from_special_use(Some("\\Other")), None);
    }

    #[test]
    fn role_from_name_detects_inbox() {
        assert_eq!(role_from_name("INBOX"), Some("inbox".into()));
        assert_eq!(role_from_name("Inbox"), Some("inbox".into()));
        assert_eq!(role_from_name("Sent"), None);
    }

    #[test]
    fn parent_of_splits_on_delimiter() {
        assert_eq!(parent_of("INBOX", "/"), None);
        assert_eq!(parent_of("A/B/C", "/"), Some("A/B".into()));
        assert_eq!(parent_of("A.B", "."), Some("A".into()));
        assert_eq!(parent_of("flat", "/"), None);
        assert_eq!(parent_of("anything", ""), None);
    }

    #[test]
    fn uid_set_joins_comma() {
        assert_eq!(uid_set(&[1, 2, 3]), "1,2,3");
        assert_eq!(uid_set(&[42]), "42");
        assert_eq!(uid_set(&[]), "");
    }

    #[test]
    fn format_flags_prepends_backslash() {
        assert_eq!(format_flags(&["\\Seen"]), "(\\Seen)");
        assert_eq!(format_flags(&["Seen", "Flagged"]), "(\\Seen \\Flagged)");
        assert_eq!(format_flags(&[]), "()");
    }

    #[test]
    fn imap_message_to_remote_maps_fields_and_attachments_flag() {
        let m = ImapMessage {
            uid: 7,
            folder: "INBOX".into(),
            message_id: Some("<m@x>".into()),
            in_reply_to: None,
            references: None,
            from_address: Some("a@b".into()),
            from_name: Some("A".into()),
            to_addresses: None,
            cc_addresses: None,
            bcc_addresses: None,
            reply_to: None,
            subject: Some("Hi".into()),
            date: 1234,
            is_read: false,
            is_starred: true,
            is_draft: false,
            body_html: Some("<p>x</p>".into()),
            body_text: Some("x".into()),
            snippet: Some("x".into()),
            raw_size: 10,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            auth_results: None,
            attachments: vec![ImapAttachment {
                part_id: "2".into(),
                filename: "f.bin".into(),
                mime_type: "application/octet-stream".into(),
                size: 5,
                content_id: None,
                is_inline: false,
            }],
        };
        let r = imap_message_to_remote(m);
        assert_eq!(r.uid, 7);
        assert_eq!(r.folder, "INBOX");
        assert_eq!(r.message_id.as_deref(), Some("<m@x>"));
        assert_eq!(r.subject.as_deref(), Some("Hi"));
        assert!(r.is_starred);
        assert!(!r.is_read);
        assert!(r.has_attachments);
    }

    #[test]
    fn imap_folder_to_remote_uses_raw_path_and_role() {
        let f = ImapFolder {
            path: "Sent".into(),
            raw_path: "Sent".into(),
            name: "Sent".into(),
            delimiter: "/".into(),
            special_use: Some("\\Sent".into()),
            exists: 5,
            unseen: 1,
        };
        let r = imap_folder_to_remote(f);
        assert_eq!(r.remote_id, "Sent");
        assert_eq!(r.role.as_deref(), Some("sent"));
        assert_eq!(r.exists, 5);
        assert_eq!(r.unseen, 1);
    }
}
