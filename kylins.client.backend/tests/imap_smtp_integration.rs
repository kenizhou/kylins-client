// IMAP/SMTP integration test suite for on-prem Exchange (kylins.local).
// Reads server credentials from environment variables so real secrets are never
// committed. Ignored by default because it requires a live mail server.
//
// Run all tests sequentially (required; parallel tests race for UIDs and
// connections on the same mailbox):
//   KYLINS_IMAP_HOST=imap.kylins.com \
//   KYLINS_IMAP_PORT=143 \
//   KYLINS_IMAP_SECURITY=starttls \
//   KYLINS_SMTP_HOST=smtp.kylins.com \
//   KYLINS_SMTP_PORT=587 \
//   KYLINS_SMTP_SECURITY=starttls \
//   KYLINS_EMAIL=felixzhou@kylins.local \
//   KYLINS_PASSWORD='P@ssw0rd' \
//   KYLINS_ACCEPT_INVALID_CERTS=true \
//   KYLINS_TEST_FOLDER=KylinsMailboxTest \
//     cargo test --test imap_smtp_integration -- --ignored --nocapture --test-threads=1

use async_imap::Session;
use base64::Engine;
use kylins_client_lib::mail::imap::{
    client as imap_client,
    client::ImapStream,
    types::{DeltaCheckRequest, ImapConfig},
};
use kylins_client_lib::mail::smtp::{client as smtp_client, types::SmtpConfig};

fn env_or(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| default.to_string())
}

fn accept_invalid_certs() -> bool {
    std::env::var("KYLINS_ACCEPT_INVALID_CERTS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn get_imap_config() -> ImapConfig {
    ImapConfig {
        host: env_or("KYLINS_IMAP_HOST", "imap.kylins.com"),
        port: env_or("KYLINS_IMAP_PORT", "143")
            .parse()
            .expect("valid IMAP port"),
        security: env_or("KYLINS_IMAP_SECURITY", "starttls"),
        username: env_or("KYLINS_EMAIL", "felixzhou@kylins.local"),
        password: env_or("KYLINS_PASSWORD", ""),
        auth_method: "password".to_string(),
        accept_invalid_certs: accept_invalid_certs(),
    }
}

fn get_smtp_config() -> SmtpConfig {
    SmtpConfig {
        host: env_or("KYLINS_SMTP_HOST", "smtp.kylins.com"),
        port: env_or("KYLINS_SMTP_PORT", "587")
            .parse()
            .expect("valid SMTP port"),
        security: env_or("KYLINS_SMTP_SECURITY", "starttls"),
        username: env_or("KYLINS_EMAIL", "felixzhou@kylins.local"),
        password: env_or("KYLINS_PASSWORD", ""),
        auth_method: "password".to_string(),
        accept_invalid_certs: accept_invalid_certs(),
    }
}

fn test_folder() -> String {
    env_or("KYLINS_TEST_FOLDER", "KylinsMailboxTest")
}

fn account_email() -> String {
    env_or("KYLINS_EMAIL", "felixzhou@kylins.local")
}

fn unique_subject(case: &str) -> String {
    format!("Kylins IMAP Test: {} {}", case, uuid::Uuid::new_v4())
}

fn rfc2822_date() -> String {
    chrono::Utc::now().to_rfc2822()
}

fn build_plain_message(subject: &str, body: &str) -> Vec<u8> {
    let email = account_email();
    format!(
        "From: {email}\r\n\
         To: {email}\r\n\
         Subject: {subject}\r\n\
         Date: {date}\r\n\
         Message-Id: <{mid}@{host}>\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\r\n\
         {body}",
        email = email,
        subject = subject,
        date = rfc2822_date(),
        mid = uuid::Uuid::new_v4(),
        host = env_or("KYLINS_IMAP_HOST", "imap.kylins.com"),
        body = body
    )
    .into_bytes()
}

fn build_multipart_message_with_attachment(
    subject: &str,
    body_text: &str,
    attachment_name: &str,
    attachment_content: &str,
) -> Vec<u8> {
    let email = account_email();
    let boundary = format!("----KylinsTestBoundary{}", uuid::Uuid::new_v4().simple());
    format!(
        "From: {email}\r\n\
         To: {email}\r\n\
         Subject: {subject}\r\n\
         Date: {date}\r\n\
         Message-Id: <{mid}@{host}>\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\r\n\
         --{boundary}\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\r\n\
         {body_text}\r\n\r\n\
         --{boundary}\r\n\
         Content-Type: text/plain; name=\"{attachment_name}\"\r\n\
         Content-Disposition: attachment; filename=\"{attachment_name}\"\r\n\r\n\
         {attachment_content}\r\n\r\n\
         --{boundary}--\r\n",
        email = email,
        subject = subject,
        date = rfc2822_date(),
        mid = uuid::Uuid::new_v4(),
        host = env_or("KYLINS_IMAP_HOST", "imap.kylins.com"),
        boundary = boundary,
        body_text = body_text,
        attachment_name = attachment_name,
        attachment_content = attachment_content
    )
    .into_bytes()
}

async fn ensure_test_folder(session: &mut Session<ImapStream>) -> Result<(), String> {
    let folder = test_folder();
    let folders = imap_client::list_folders(session).await?;
    if folders
        .iter()
        .any(|f| f.path == folder || f.raw_path == folder)
    {
        return Ok(());
    }
    // Some servers (Exchange IMAP in particular) cache the folder list and report
    // "Folder name is reserved" when a concurrent or recent CREATE for the same
    // name has already succeeded. Treat that as "folder already exists".
    if let Err(e) = imap_client::create_folder(session, &folder).await {
        let msg = e.to_string().to_lowercase();
        if msg.contains("reserved") || msg.contains("already exists") {
            eprintln!("ensure_test_folder: treating create error as exists: {}", e);
            return Ok(());
        }
        return Err(e);
    }
    Ok(())
}

async fn cleanup_uids(session: &mut Session<ImapStream>, folder: &str, uids: &[u32]) {
    if uids.is_empty() {
        return;
    }
    let uid_set: String = uids
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");
    if let Err(e) = imap_client::delete_messages(session, folder, &uid_set).await {
        eprintln!(
            "Cleanup warning: could not delete UIDs {} in {}: {}",
            uid_set, folder, e
        );
    }
}

async fn find_uid_by_subject(
    session: &mut Session<ImapStream>,
    config: &ImapConfig,
    folder: &str,
    subject: &str,
) -> Result<Option<u32>, String> {
    let uids = imap_client::search_all_uids(session, folder).await?;
    if uids.is_empty() {
        return Ok(None);
    }
    // Use the raw TCP fetch path to avoid async-imap's empty-fetch bug on Exchange.
    for uid in uids {
        let result = imap_client::raw_fetch_messages(config, folder, &uid.to_string()).await?;
        if result
            .messages
            .iter()
            .any(|m| m.subject.as_deref() == Some(subject))
        {
            return Ok(Some(uid));
        }
    }
    Ok(None)
}

async fn append_message(
    session: &mut Session<ImapStream>,
    config: &ImapConfig,
    folder: &str,
    subject: &str,
    raw: &[u8],
) -> Result<u32, String> {
    imap_client::append_message(session, folder, None, raw).await?;
    // APPEND does not return the UID in the current implementation (UIDPLUS
    // APPENDUID parsing is not implemented), so we locate the message by subject.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    for _ in 0..10 {
        if let Some(uid) = find_uid_by_subject(session, config, folder, subject).await? {
            return Ok(uid);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err(format!(
        "Could not locate appended message with subject '{}' in {}",
        subject, folder
    ))
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_starttls_test_connection() {
    let config = get_imap_config();
    let result = imap_client::test_connection(&config).await;
    assert!(
        result.is_ok(),
        "IMAP test_connection failed: {:?}",
        result.err()
    );
    println!("IMAP: {}", result.unwrap());
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn smtp_starttls_test_connection() {
    let config = get_smtp_config();
    let result = smtp_client::test_connection(&config).await;
    assert!(
        result.is_ok(),
        "SMTP test_connection failed: {:?}",
        result.err()
    );
    let outcome = result.unwrap();
    assert!(
        outcome.success,
        "SMTP server rejected connection: {}",
        outcome.message
    );
    println!("SMTP: {}", outcome.message);
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_list_folders() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    let folders = imap_client::list_folders(&mut session)
        .await
        .expect("list folders");
    assert!(
        folders.iter().any(|f| f.name.eq_ignore_ascii_case("INBOX")),
        "INBOX not found in folder list"
    );
    println!("Folders: {} total", folders.len());
    for f in &folders {
        println!("  - {} (special_use: {:?})", f.path, f.special_use);
    }
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_folder_status() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    let status = imap_client::get_folder_status(&mut session, "INBOX")
        .await
        .expect("status");
    println!(
        "INBOX status: exists={}, unseen={}, uidvalidity={}, uidnext={}",
        status.exists, status.unseen, status.uidvalidity, status.uidnext
    );
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_append_and_fetch_plain_text() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut session)
        .await
        .expect("test folder exists");

    let subject = unique_subject("append-and-fetch-plain-text");
    let body = "This is a plain-text test message created by the Kylins IMAP integration test.";
    let raw = build_plain_message(&subject, body);
    let uid = append_message(&mut session, &config, &test_folder(), &subject, &raw)
        .await
        .expect("append");

    let result = imap_client::raw_fetch_messages(&config, &test_folder(), &uid.to_string())
        .await
        .expect("fetch")
        .messages
        .into_iter()
        .next()
        .expect("fetch returned message");
    assert_eq!(result.subject.as_deref(), Some(subject.as_str()));
    assert!(
        result.body_text.as_deref().unwrap_or("").contains(body),
        "Fetched body does not contain expected text"
    );
    println!("APPEND+FETCH OK: uid={} subject='{}'", uid, subject);

    cleanup_uids(&mut session, &test_folder(), &[uid]).await;
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_flag_update() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut session)
        .await
        .expect("test folder exists");

    let subject = unique_subject("flag-update-seen-flagged");
    let raw = build_plain_message(
        &subject,
        "This message tests setting and clearing \\Seen and \\Flagged flags.",
    );
    let uid = append_message(&mut session, &config, &test_folder(), &subject, &raw)
        .await
        .expect("append");

    // Set \Seen and \Flagged
    imap_client::set_flags(
        &mut session,
        &test_folder(),
        &uid.to_string(),
        "+FLAGS",
        "(\\Seen \\Flagged)",
    )
    .await
    .expect("set flags");

    let result = imap_client::raw_fetch_messages(&config, &test_folder(), &uid.to_string())
        .await
        .expect("fetch after flag set")
        .messages
        .into_iter()
        .next()
        .expect("fetch returned message");
    assert!(result.is_read, "Message should be \\Seen");
    assert!(result.is_starred, "Message should be \\Flagged");

    // Clear \Flagged
    imap_client::set_flags(
        &mut session,
        &test_folder(),
        &uid.to_string(),
        "-FLAGS",
        "(\\Flagged)",
    )
    .await
    .expect("clear flagged");

    let result = imap_client::raw_fetch_messages(&config, &test_folder(), &uid.to_string())
        .await
        .expect("fetch after flag clear")
        .messages
        .into_iter()
        .next()
        .expect("fetch returned message");
    assert!(result.is_read, "Message should still be \\Seen");
    assert!(!result.is_starred, "Message should no longer be \\Flagged");

    println!("FLAG UPDATE OK: uid={} subject='{}'", uid, subject);
    cleanup_uids(&mut session, &test_folder(), &[uid]).await;
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_copy_message() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut session)
        .await
        .expect("test folder exists");

    let subject = unique_subject("copy-message");
    let raw = build_plain_message(&subject, "This message tests copying between folders.");
    let uid = append_message(&mut session, &config, &test_folder(), &subject, &raw)
        .await
        .expect("append");

    imap_client::copy_messages(&mut session, &test_folder(), &uid.to_string(), "INBOX")
        .await
        .expect("copy");

    // Verify the original is still in the test folder.
    let original = find_uid_by_subject(&mut session, &config, &test_folder(), &subject)
        .await
        .expect("search test folder");
    assert!(
        original.is_some(),
        "Original message not found in source folder after COPY"
    );

    // Verify the copy is in INBOX.
    let copied_uid = find_uid_by_subject(&mut session, &config, "INBOX", &subject)
        .await
        .expect("search inbox");
    assert!(copied_uid.is_some(), "Copied message not found in INBOX");

    println!(
        "COPY OK: src_uid={} copied_uid={} subject='{}'",
        uid,
        copied_uid.unwrap(),
        subject
    );
    cleanup_uids(&mut session, &test_folder(), &[uid]).await;
    cleanup_uids(&mut session, "INBOX", &[copied_uid.unwrap()]).await;
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_move_message() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut session)
        .await
        .expect("test folder exists");

    let subject = unique_subject("move-message");
    let raw = build_plain_message(&subject, "This message tests moving between folders.");
    let uid = append_message(&mut session, &config, &test_folder(), &subject, &raw)
        .await
        .expect("append");

    imap_client::move_messages(&mut session, &test_folder(), &uid.to_string(), "INBOX")
        .await
        .expect("move");

    // Verify the message is no longer in the test folder.
    let remaining = find_uid_by_subject(&mut session, &config, &test_folder(), &subject)
        .await
        .expect("search test folder");
    assert!(
        remaining.is_none(),
        "Message still in source folder after MOVE"
    );

    // Verify it arrived in INBOX.
    let moved_uid = find_uid_by_subject(&mut session, &config, "INBOX", &subject)
        .await
        .expect("search inbox");
    assert!(moved_uid.is_some(), "Message not found in INBOX after MOVE");

    println!(
        "MOVE OK: src_uid={} dest_uid={} subject='{}'",
        uid,
        moved_uid.unwrap(),
        subject
    );
    cleanup_uids(&mut session, "INBOX", &[moved_uid.unwrap()]).await;
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_delete_and_expunge() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut session)
        .await
        .expect("test folder exists");

    let subject = unique_subject("delete-and-expunge");
    let raw = build_plain_message(&subject, "This message tests deletion and expunge.");
    let uid = append_message(&mut session, &config, &test_folder(), &subject, &raw)
        .await
        .expect("append");

    imap_client::delete_messages(&mut session, &test_folder(), &uid.to_string())
        .await
        .expect("delete");

    let remaining = find_uid_by_subject(&mut session, &config, &test_folder(), &subject)
        .await
        .expect("search after delete");
    assert!(
        remaining.is_none(),
        "Message still exists after delete+expunge"
    );
    println!("DELETE+EXPUNGE OK: uid={} subject='{}'", uid, subject);
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_search_since() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut session)
        .await
        .expect("test folder exists");

    let subject = unique_subject("search-since");
    let raw = build_plain_message(&subject, "This message tests UID SEARCH SINCE.");
    let uid = append_message(&mut session, &config, &test_folder(), &subject, &raw)
        .await
        .expect("append");

    let today = chrono::Utc::now().format("%d-%b-%Y").to_string();
    let result = imap_client::search_folder(&mut session, &test_folder(), Some(today))
        .await
        .expect("search folder");
    assert!(
        result.uids.contains(&uid),
        "UID {} not found in SINCE search results {:?}",
        uid,
        result.uids
    );
    println!("SEARCH SINCE OK: uid={} subject='{}'", uid, subject);
    cleanup_uids(&mut session, &test_folder(), &[uid]).await;
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_delta_check() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut session)
        .await
        .expect("test folder exists");

    let subject = unique_subject("delta-check");
    let raw = build_plain_message(&subject, "This message tests delta checking.");
    let uid = append_message(&mut session, &config, &test_folder(), &subject, &raw)
        .await
        .expect("append");

    let requests = vec![DeltaCheckRequest {
        folder: test_folder(),
        last_uid: uid - 1,
        uidvalidity: 0,
    }];
    let results = imap_client::delta_check_folders(&mut session, &requests)
        .await
        .expect("delta check");
    assert_eq!(results.len(), 1);
    let result = &results[0];
    assert!(
        result.new_uids.contains(&uid),
        "UID {} not in delta-check new_uids {:?}",
        uid,
        result.new_uids
    );
    println!(
        "DELTA CHECK OK: uid={} subject='{}' uidvalidity={}",
        uid, subject, result.uidvalidity
    );
    cleanup_uids(&mut session, &test_folder(), &[uid]).await;
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_append_and_fetch_attachment() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut session)
        .await
        .expect("test folder exists");

    let subject = unique_subject("append-and-fetch-attachment");
    let attachment_name = "kylins-test-attachment.txt";
    let attachment_content = "This is a test attachment from the Kylins IMAP integration test.";
    let raw = build_multipart_message_with_attachment(
        &subject,
        "This message has a plain-text attachment.",
        attachment_name,
        attachment_content,
    );
    let uid = append_message(&mut session, &config, &test_folder(), &subject, &raw)
        .await
        .expect("append");

    // Fetch the full message and verify the attachment metadata.
    let result = imap_client::raw_fetch_messages(&config, &test_folder(), &uid.to_string())
        .await
        .expect("fetch")
        .messages
        .into_iter()
        .next()
        .expect("fetch returned message");
    assert_eq!(result.subject.as_deref(), Some(subject.as_str()));
    assert!(
        !result.attachments.is_empty(),
        "No attachments parsed from multipart message"
    );
    let attachment = &result.attachments[0];
    assert_eq!(attachment.filename, attachment_name);
    assert!(attachment.mime_type.contains("text/plain"));

    // Fetch the attachment body by section. For a simple multipart/mixed with one
    // text part + one attachment, the attachment is section "2".
    let data_b64 = imap_client::fetch_attachment(&mut session, &test_folder(), uid, "2")
        .await
        .expect("fetch attachment");
    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .expect("attachment base64 decode");
    let decoded = String::from_utf8_lossy(&data).trim_end().to_string();
    assert_eq!(decoded, attachment_content);

    println!(
        "ATTACHMENT OK: uid={} subject='{}' filename='{}'",
        uid, subject, attachment_name
    );
    cleanup_uids(&mut session, &test_folder(), &[uid]).await;
}

#[tokio::test]
#[ignore = "requires live mail server credentials"]
async fn imap_sync_folder_batch() {
    let config = get_imap_config();
    let mut session = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut session)
        .await
        .expect("test folder exists");

    let subject = unique_subject("sync-folder-batch");
    let raw = build_plain_message(&subject, "This message tests folder synchronization.");
    let uid = append_message(&mut session, &config, &test_folder(), &subject, &raw)
        .await
        .expect("append");

    let result = imap_client::raw_fetch_messages(&config, &test_folder(), &uid.to_string())
        .await
        .expect("sync folder");
    assert!(
        result.messages.iter().any(|m| m.uid == uid),
        "Synced messages do not include uid {}",
        uid
    );
    println!(
        "SYNC FOLDER OK: uid={} subject='{}' messages={}",
        uid,
        subject,
        result.messages.len()
    );
    cleanup_uids(&mut session, &test_folder(), &[uid]).await;
}
