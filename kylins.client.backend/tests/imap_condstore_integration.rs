// Live-server CONDSTORE + expunge integration tests for the Phase 3e sync engine.
//
// These are end-to-end through `ImapSource::sync_folder` -> `apply_folder_delta`:
// they prove that flag changes performed by a SECOND IMAP connection (simulating
// another client / webmail) are reflected locally on the next sync, and that
// server-side expunges are detected via the set-difference path and removed from
// the local cache.
//
// Ignored by default because they need a real CONDSTORE-capable IMAP server.
// Reuses the `KYLINS_IMAP_*` env-var harness from `imap_smtp_integration.rs`.
//
// Run sequentially (parallel tests race for UIDs/connections on the same mailbox):
//   KYLINS_IMAP_HOST=imap.kylins.com \
//   KYLINS_IMAP_PORT=143 \
//   KYLINS_IMAP_SECURITY=starttls \
//   KYLINS_EMAIL=felixzhou@kylins.local \
//   KYLINS_PASSWORD='P@ssw0rd' \
//   KYLINS_ACCEPT_INVALID_CERTS=true \
//   KYLINS_TEST_FOLDER=KylinsMailboxTest \
//     cargo test --test imap_condstore_integration -- --ignored --nocapture --test-threads=1

use async_imap::Session;
use kylins_client_lib::db::init_db;
use kylins_client_lib::db::accounts::Account;
use kylins_client_lib::db::messages::{apply_folder_delta, list_local_uids};
use kylins_client_lib::mail::imap::client::ImapStream;
use kylins_client_lib::mail::imap::{client as imap_client, types::ImapConfig};
use kylins_client_lib::sync_engine::imap_source::ImapSource;
use kylins_client_lib::sync_engine::{Cursor, MailSource, RemoteFolder};

/// Alias matching the private `client::ImapSession = Session<ImapStream>` so the
/// helper signatures read cleanly. The existing `imap_smtp_integration.rs`
/// harness uses the same `Session<ImapStream>` form.
type ImapSession = Session<ImapStream>;

// ---- env-var helpers (mirror imap_smtp_integration.rs) ----

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

fn test_folder() -> String {
    env_or("KYLINS_TEST_FOLDER", "KylinsMailboxTest")
}

fn account_email() -> String {
    env_or("KYLINS_EMAIL", "felixzhou@kylins.local")
}

fn unique_subject(case: &str) -> String {
    format!("Kylins CONDSTORE Test: {} {}", case, uuid::Uuid::new_v4())
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

/// Build an `Account` whose IMAP fields come from the env-var harness. `id` is a
/// stable synthetic value so `messages.id` (= `imap-{account}-{folder}-{uid}`)
/// is deterministic and `apply_folder_delta` can find the rows it just wrote.
fn account_from_env(account_id: &str) -> Account {
    let config = get_imap_config();
    Account {
        id: account_id.to_string(),
        email: account_email(),
        provider: "imap".into(),
        imap_host: Some(config.host.clone()),
        imap_port: Some(config.port as i64),
        imap_security: Some(config.security.clone()),
        imap_username: Some(config.username.clone()),
        imap_password: Some(config.password.clone()),
        auth_method: Some(config.auth_method.clone()),
        accept_invalid_certs: config.accept_invalid_certs,
        ..Account::default()
    }
}

/// A `RemoteFolder` matching what `list_folders` would produce for the test
/// folder. We construct it directly (rather than calling `list_folders` and
/// searching) so the test does not depend on the folder existing ahead of time
/// and stays focused on the sync path.
fn remote_folder(path: &str) -> RemoteFolder {
    RemoteFolder {
        remote_id: path.to_string(),
        name: path.to_string(),
        delimiter: "/".to_string(),
        ..Default::default()
    }
}

/// Ensure the test folder exists on the server (idempotent). Mirrors the helper
/// in `imap_smtp_integration.rs`.
async fn ensure_test_folder(session: &mut ImapSession) -> Result<(), String> {
    let folder = test_folder();
    let folders = imap_client::list_folders(session).await?;
    if folders
        .iter()
        .any(|f| f.path == folder || f.raw_path == folder)
    {
        return Ok(());
    }
    if let Err(e) = imap_client::create_folder(session, &folder).await {
        let msg = e.to_string().to_lowercase();
        if msg.contains("reserved") || msg.contains("already exists") {
            return Ok(());
        }
        return Err(e);
    }
    Ok(())
}

/// APPEND does not return the UID in the current implementation; locate the new
/// message by subject via the raw TCP fetch path (avoids async-imap's
/// empty-fetch bug on Exchange).
async fn append_and_find_uid(
    session: &mut ImapSession,
    config: &ImapConfig,
    folder: &str,
    subject: &str,
    raw: &[u8],
) -> Result<u32, String> {
    imap_client::append_message(session, folder, None, raw).await?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    for _ in 0..10 {
        let uids = imap_client::search_all_uids(session, folder).await?;
        for uid in &uids {
            let result = imap_client::raw_fetch_messages(config, folder, &uid.to_string()).await?;
            if result
                .messages
                .iter()
                .any(|m| m.subject.as_deref() == Some(subject))
            {
                return Ok(*uid);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err(format!(
        "Could not locate appended message with subject '{subject}' in {folder}"
    ))
}

async fn cleanup_uids(session: &mut ImapSession, folder: &str, uids: &[u32]) {
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

/// Read `is_read` for one cached message. Returns `None` if the row is gone
/// (used by the expunge test to confirm deletion).
async fn local_is_read(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> Result<Option<bool>, String> {
    let row: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT is_read FROM messages WHERE account_id = ? AND imap_folder = ? AND imap_uid = ?",
    )
    .bind(account_id)
    .bind(folder)
    .bind(uid as i64)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    // Map the inner i64 to bool; NULL is_read counts as false (unread).
    Ok(row.map(|(v,)| v.unwrap_or(0) != 0))
}

// =====================================================================
// Test 1: CONDSTORE flag delta — \Seen flip on a second connection is
// reflected locally through the engine on the next sync.
// =====================================================================
#[tokio::test]
#[ignore = "requires a live CONDSTORE-capable IMAP server"]
async fn test_changed_flags_via_condstore() {
    let config = get_imap_config();
    let folder_path = test_folder();
    let account_id = "condstore-flag-test";

    // --- Local DB: account + label rows so apply_folder_delta has parents. ---
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = init_db(tmp.path()).await.expect("init_db");
    sqlx::query("INSERT INTO accounts (id, email, provider) VALUES (?, ?, 'imap')")
        .bind(account_id)
        .bind(account_email())
        .execute(&pool)
        .await
        .expect("insert account");
    let label_id = format!("{account_id}:{folder_path}");
    sqlx::query(
        "INSERT INTO labels (id, account_id, name, type, visible, sort_order, source, remote_id, mail_class)
         VALUES (?, ?, ?, 'user', 1, 0, 'imap', ?, 'mail')",
    )
    .bind(&label_id)
    .bind(account_id)
    .bind(&folder_path)
    .bind(&folder_path)
    .execute(&pool)
    .await
    .expect("insert label");

    let source = ImapSource::new(
        account_from_env(account_id),
        pool.clone(),
        std::sync::Arc::new(kylins_client_lib::mail::imap::session_manager::ImapSessionManager::new()),
    );
    let folder = remote_folder(&folder_path);

    // --- Ensure the folder exists, then append a fresh unread message. ---
    let mut setup = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut setup).await.expect("ensure folder");
    let subject = unique_subject("changed-flags-via-condstore");
    let raw = build_plain_message(&subject, "CONDSTORE flag-delta e2e.");
    let uid = append_and_find_uid(&mut setup, &config, &folder_path, &subject, &raw)
        .await
        .expect("append + find uid");
    let _ = setup.logout().await;
    println!("[condstore] appended uid={uid} subject='{subject}'");

    // --- First sync: seeds the message locally with is_read=false. ---
    let delta1 = source
        .sync_folder(&folder, Cursor::initial_imap())
        .await
        .expect("sync #1");
    assert!(
        delta1.added.iter().any(|m| m.uid == uid),
        "sync #1 did not return the appended uid {uid} (added {:?})",
        delta1.added.iter().map(|m| m.uid).collect::<Vec<_>>()
    );
    let cursor1 = delta1.next_cursor.clone();
    apply_folder_delta(&pool, account_id, &label_id, &folder_path, &delta1)
        .await
        .expect("apply delta #1");
    let is_read_before = local_is_read(&pool, account_id, &folder_path, uid)
        .await
        .expect("query is_read #1")
        .expect("row present after sync #1");
    assert!(
        !is_read_before,
        "message must start unread (is_read=false) before the flip; got is_read=true"
    );
    println!(
        "[condstore] sync #1 seeded: uid={uid} is_read=false, cursor modseq={:?}",
        match &cursor1 {
            Cursor::Imap { highest_modseq, .. } => Some(highest_modseq),
            _ => None,
        }
    );

    // --- Flip \\Seen via a SECOND connection (simulating webmail / another client). ---
    let mut other = imap_client::connect(&config).await.expect("connect #2");
    imap_client::set_flags(
        &mut other,
        &folder_path,
        &uid.to_string(),
        "+FLAGS",
        "(\\Seen)",
    )
    .await
    .expect("STORE +FLAGS \\Seen");
    let _ = other.logout().await;
    println!("[condstore] flipped \\Seen on uid={uid} via second connection");

    // Give the server a beat to settle the modseq bump.
    tokio::time::sleep(std::time::Duration::from_millis(750)).await;

    // --- Second sync from the advanced cursor: CONDSTORE CHANGEDSINCE should
    //     report uid as changed and produce a FlagUpdate flipping is_read. ---
    let delta2 = source
        .sync_folder(&folder, cursor1.clone())
        .await
        .expect("sync #2");
    apply_folder_delta(&pool, account_id, &label_id, &folder_path, &delta2)
        .await
        .expect("apply delta #2");
    let is_read_after = local_is_read(&pool, account_id, &folder_path, uid)
        .await
        .expect("query is_read #2")
        .expect("row still present after sync #2");

    // Determine whether the server advertised CONDSTORE. If it did, the flag
    // MUST have flipped through the engine; if it did NOT, the engine's
    // documented behavior is a graceful no-op (flag unchanged) — assert that
    // instead of failing the test, matching the brief.
    let caps = source.capabilities();
    if caps.condstore {
        assert!(
            delta2
                .flag_updates
                .iter()
                .any(|u| u.uid == uid && u.is_read),
            "CONDSTORE server: flag_updates must contain uid={uid} with is_read=true; got {:?}",
            delta2.flag_updates
        );
        assert!(
            is_read_after,
            "CONDSTORE server: message must be is_read=true after the second sync; got false"
        );
        println!(
            "[condstore] PASS: uid={uid} flipped is_read false->true via CONDSTORE delta ({} flag update(s))",
            delta2.flag_updates.len()
        );
    } else {
        // Non-CONDSTORE server: engine skips the flag delta (logs warn). The
        // brief requires the graceful no-op rather than a failure.
        assert!(
            !is_read_after,
            "non-CONDSTORE server: graceful fallback must leave is_read unchanged (still false); got true"
        );
        assert!(
            delta2.flag_updates.is_empty(),
            "non-CONDSTORE server must not emit flag_updates; got {:?}",
            delta2.flag_updates
        );
        println!(
            "[condstore] PASS (graceful fallback): server lacks CONDSTORE; uid={uid} stays unread, no flag_updates emitted"
        );
    }

    // --- Cleanup so the test is repeatable. ---
    let mut cleanup = imap_client::connect(&config).await.expect("connect cleanup");
    cleanup_uids(&mut cleanup, &folder_path, &[uid]).await;
    let _ = cleanup.logout().await;
}

// =====================================================================
// Test 2: Expunge detection via set-difference — a message deleted +
// expunged on a second connection shows up in vanished_uids and is
// removed from the local cache on the next sync.
// =====================================================================
#[tokio::test]
#[ignore = "requires a live IMAP server"]
async fn test_expunge_detected_via_set_difference() {
    let config = get_imap_config();
    let folder_path = test_folder();
    let account_id = "expunge-setdiff-test";

    // --- Local DB: account + label rows. ---
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = init_db(tmp.path()).await.expect("init_db");
    sqlx::query("INSERT INTO accounts (id, email, provider) VALUES (?, ?, 'imap')")
        .bind(account_id)
        .bind(account_email())
        .execute(&pool)
        .await
        .expect("insert account");
    let label_id = format!("{account_id}:{folder_path}");
    sqlx::query(
        "INSERT INTO labels (id, account_id, name, type, visible, sort_order, source, remote_id, mail_class)
         VALUES (?, ?, ?, 'user', 1, 0, 'imap', ?, 'mail')",
    )
    .bind(&label_id)
    .bind(account_id)
        .bind(&folder_path)
        .bind(&folder_path)
        .execute(&pool)
        .await
        .expect("insert label");

    let source = ImapSource::new(
        account_from_env(account_id),
        pool.clone(),
        std::sync::Arc::new(kylins_client_lib::mail::imap::session_manager::ImapSessionManager::new()),
    );
    let folder = remote_folder(&folder_path);

    // --- Append two fresh messages. ---
    let mut setup = imap_client::connect(&config).await.expect("connect");
    ensure_test_folder(&mut setup).await.expect("ensure folder");
    let subject_keep = unique_subject("expunge-keep");
    let subject_kill = unique_subject("expunge-kill");
    let raw_keep = build_plain_message(&subject_keep, "This one survives.");
    let raw_kill = build_plain_message(&subject_kill, "This one gets expunged.");
    let uid_keep = append_and_find_uid(&mut setup, &config, &folder_path, &subject_keep, &raw_keep)
        .await
        .expect("append keep");
    let uid_kill = append_and_find_uid(&mut setup, &config, &folder_path, &subject_kill, &raw_kill)
        .await
        .expect("append kill");
    let _ = setup.logout().await;
    println!(
        "[expunge] appended uid_keep={uid_keep} uid_kill={uid_kill} (subjects keep='{subject_keep}' kill='{subject_kill}')"
    );

    // --- First sync: both messages cached locally. ---
    let delta1 = source
        .sync_folder(&folder, Cursor::initial_imap())
        .await
        .expect("sync #1");
    apply_folder_delta(&pool, account_id, &label_id, &folder_path, &delta1)
        .await
        .expect("apply delta #1");
    let cursor1 = delta1.next_cursor.clone();
    let local_after_sync1 = list_local_uids(&pool, account_id, &folder_path)
        .await
        .expect("list local uids #1");
    assert!(
        local_after_sync1.contains(&uid_keep),
        "uid_keep={uid_keep} must be cached after sync #1; got {local_after_sync1:?}"
    );
    assert!(
        local_after_sync1.contains(&uid_kill),
        "uid_kill={uid_kill} must be cached after sync #1; got {local_after_sync1:?}"
    );
    println!("[expunge] sync #1 cached both uids: {local_after_sync1:?}");

    // --- Delete + EXPUNGE uid_kill via a SECOND connection. ---
    let mut other = imap_client::connect(&config).await.expect("connect #2");
    imap_client::delete_messages(&mut other, &folder_path, &uid_kill.to_string())
        .await
        .expect("delete + expunge uid_kill");
    let _ = other.logout().await;
    println!("[expunge] deleted+expunged uid_kill={uid_kill} via second connection");

    // Give the server a beat to settle.
    tokio::time::sleep(std::time::Duration::from_millis(750)).await;

    // --- Second sync: set-difference (server UID SEARCH ALL minus local UIDs)
    //     must surface uid_kill in vanished_uids, and apply_folder_delta must
    //     delete it locally. uid_keep stays. ---
    let delta2 = source
        .sync_folder(&folder, cursor1)
        .await
        .expect("sync #2");
    assert!(
        delta2.vanished_uids.contains(&uid_kill),
        "vanished_uids must contain the expunged uid {uid_kill}; got {:?}",
        delta2.vanished_uids
    );
    assert!(
        !delta2.vanished_uids.contains(&uid_keep),
        "vanished_uids must NOT contain the surviving uid {uid_keep}; got {:?}",
        delta2.vanished_uids
    );
    apply_folder_delta(&pool, account_id, &label_id, &folder_path, &delta2)
        .await
        .expect("apply delta #2");

    let local_after_sync2 = list_local_uids(&pool, account_id, &folder_path)
        .await
        .expect("list local uids #2");
    assert!(
        !local_after_sync2.contains(&uid_kill),
        "expunged uid_kill={uid_kill} must be gone from local cache after sync #2; got {local_after_sync2:?}"
    );
    assert!(
        local_after_sync2.contains(&uid_keep),
        "surviving uid_keep={uid_keep} must still be cached after sync #2; got {local_after_sync2:?}"
    );

    println!(
        "[expunge] PASS: uid_kill={uid_kill} in vanished_uids and removed locally; uid_keep={uid_keep} retained. remaining={local_after_sync2:?}"
    );

    // --- Cleanup the survivor so the test is repeatable. ---
    let mut cleanup = imap_client::connect(&config).await.expect("connect cleanup");
    cleanup_uids(&mut cleanup, &folder_path, &[uid_keep]).await;
    let _ = cleanup.logout().await;
}
