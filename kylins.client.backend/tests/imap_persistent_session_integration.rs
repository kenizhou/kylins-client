// Live-server connection-count proof for the Phase 3 imapflow-learnings work
// (Tasks 1-6: persistent `ImapSessionManager`).
//
// THE LOAD-BEARING ASSERTION: one persistent IMAP session per account across
// multiple `MailSource` ops. Before this plan, `ImapSource::list_folders` and
// `sync_folder` each opened their own connection (and `sync_folder`'s raw-fetch
// fallback reconnected per batch) — a 10-folder sync round on the quirk server
// opened 10+ connections and triggered a `* BYE Connection closed` storm.
// After this plan, every session-using op runs through
// `ImapSessionManager::execute`, which lazily connects ONCE and reuses the
// session (re-SELECTing only when the folder changes).
//
// This test proves it structurally — without parsing backend logs — by reading
// the manager's internal state after a multi-op round:
//   1. `accounts` map holds exactly ONE entry for the account (one Handle).
//   2. That Handle's `session` slot is `Some` (still alive — NOT dropped +
//      re-dialed between ops). Pre-Task-4 each op dropped its session on
//      return, so this slot would have been transient.
//   3. The SAME `Arc<Handle>` is handed out across ops (`Arc::ptr_eq`), proving
//      reuse rather than per-call construction.
//
// Ignored by default — needs a real IMAP server. Reuses the
// `KYLINS_IMAP_*` env-var harness from `imap_smtp_integration.rs`.
//
//   KYLINS_IMAP_HOST=imap.kylins.com \
//   KYLINS_IMAP_PORT=143 \
//   KYLINS_IMAP_SECURITY=starttls \
//   KYLINS_EMAIL=felixzhou@kylins.local \
//   KYLINS_PASSWORD='P@ssw0rd' \
//   KYLINS_ACCEPT_INVALID_CERTS=true \
//   KYLINS_TEST_FOLDER=KylinsMailboxTest \
//     cargo test --test imap_persistent_session_integration -- --ignored --nocapture --test-threads=1

use kylins_client_lib::db::init_db;
use kylins_client_lib::db::accounts::Account;
use kylins_client_lib::mail::imap::session_manager::ImapSessionManager;
use kylins_client_lib::mail::imap::types::ImapConfig;
use kylins_client_lib::sync_engine::imap_source::ImapSource;
use kylins_client_lib::sync_engine::{Cursor, MailSource, RemoteFolder};

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

/// Build an `Account` whose IMAP fields come from the env-var harness (same
/// shape as the condstore integration test's helper).
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

/// A `RemoteFolder` matching what `list_folders` produces for the test folder.
fn remote_folder(path: &str) -> RemoteFolder {
    RemoteFolder {
        remote_id: path.to_string(),
        name: path.to_string(),
        delimiter: "/".to_string(),
        ..Default::default()
    }
}

/// **The connection-count proof.** Runs two session-using `MailSource` ops
/// (`list_folders`, then `sync_folder`) against the SAME `ImapSource` / manager,
/// then asserts the manager reused ONE persistent session rather than dialing
/// per op.
///
/// What this catches:
/// - If a future refactor re-introduces per-call `imap_client::connect()` inside
///   `ImapSource` (bypassing `manager.execute`), the `accounts` map would still
///   hold one Handle, BUT the `session` slot would be `None` after each op
///   dropped its connection — assertion (2) fails.
/// - If a refactor accidentally keyed the map by op+folder (instead of by
///   account), the map would grow beyond one entry — assertion (1) fails.
/// - If `handle_for` returned a fresh `Arc` per call (instead of cloning the
///   stored one), `Arc::ptr_eq` would be false — assertion (3) fails.
///
/// What this does NOT catch (out of scope for a unit-testable proof):
/// - The raw-fetch fallback's per-batch reconnect on quirk servers (the
///   `ASYNC_IMAP_EMPTY` path runs its own dedicated connection — documented
///   deferred item; not a regression). On a non-quirk server this fallback
///   never fires, so the proof below IS the complete connection count.
/// - The NOOP keepalive's connection use — the keepalive never dials; it only
///   NOOPs on the existing session or skips when `session` is `None`.
#[tokio::test]
#[ignore = "requires a live IMAP server"]
async fn one_persistent_session_per_account_across_multiple_ops() {
    let config = get_imap_config();
    let folder_path = test_folder();
    let account_id = "persistent-session-proof";

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

    // One manager shared across the source (the production wiring —
    // `SyncEngine::session_manager` is an `Arc<ImapSessionManager>` passed to
    // every `source_for_account` call).
    let manager = std::sync::Arc::new(ImapSessionManager::new());
    let source = ImapSource::new(account_from_env(account_id), pool.clone(), manager.clone());

    // ============================ Op #1: list_folders ============================
    // Pre-Task-4: this dialed its own connection, ran LIST, and dropped it.
    // Post-Task-4: lazily connects via the manager and the session STAYS alive.
    let folders = source.list_folders().await.expect("list_folders");
    println!(
        "[persistent-session] list_folders returned {} folder(s)",
        folders.len()
    );

    // Capture the Handle handed out after op #1 (the one and only Handle for
    // this account, per the manager's get-or-insert map). `handle_for` is a
    // pub method — invoking it here does NOT create a new entry; it returns
    // the existing Arc (or inserts if absent, which would itself be a bug post-
    // list_folders).
    let handle_after_op1 = manager
        .handle_for(account_id, &config)
        .await;

    // ============================ Op #2: sync_folder ============================
    // Pre-Task-4: dialed AGAIN (second connection this round), ran SELECT +
    // UID FETCH, dropped on return. Post-Task-4: reuses the op-#1 session,
    // re-SELECTs only because the folder differs from the un-SELECTed state.
    let folder = remote_folder(&folder_path);
    let delta = source
        .sync_folder(&folder, Cursor::initial_imap())
        .await
        .expect("sync_folder");
    println!(
        "[persistent-session] sync_folder '{}' returned {} added / {} vanished",
        folder_path,
        delta.added.len(),
        delta.vanished_uids.len()
    );

    // Capture the Handle again AFTER op #2. If the manager reused the session,
    // this is pointer-equal to handle_after_op1.
    let handle_after_op2 = manager
        .handle_for(account_id, &config)
        .await;

    // ============================ THE PROOF ============================
    let map = manager.accounts.lock().await;

    // (1) Exactly ONE Handle for this account in the whole map — no per-op
    //     handles were inserted. (The map is keyed by account_id; if a future
    //     refactor keyed by op or folder, this would be > 1.)
    assert_eq!(
        map.len(),
        1,
        "manager should hold exactly ONE Handle (for the account), not one per op; got {}",
        map.len()
    );
    // Clone the Arc out of the map so we can release the map guard before the
    // later shutdown() (which itself takes the map lock — can't hold it here).
    // `Arc::clone` is cheap (one refcount bump) and is the same shape
    // `handle_for` uses to hand the Handle out to callers.
    let stored = map
        .get(account_id)
        .expect("Handle for our account_id must be present after two ops")
        .clone();
    drop(map);

    // (2) The stored Handle's session slot is STILL Some — proving the session
    //     was reused across both ops, NOT dropped + re-dialed. (Pre-Task-4 each
    //     op dropped its own session, so there would be no shared slot to
    //     inspect; this assertion is structurally impossible to express against
    //     the old code, which is itself the proof.)
    {
        let session_guard = stored.session.lock().await;
        assert!(
            session_guard.is_some(),
            "session slot must be Some after two ops (persistent session reused); \
             got None — a per-op connect/drop regression has been re-introduced"
        );
    }

    // (3) Pointer equality: the SAME Arc<Handle> was handed out across both ops.
    //     `handle_for` must clone the stored Arc, not construct a fresh one.
    assert!(
        std::sync::Arc::ptr_eq(&handle_after_op1, &handle_after_op2),
        "handle_for must return the SAME Arc<Handle> across ops (reuse); got two distinct Arcs"
    );
    assert!(
        std::sync::Arc::ptr_eq(&handle_after_op1, &stored),
        "the Handle handed to callers must be the one stored in the map (not a copy)"
    );

    println!(
        "[persistent-session] PASS: 1 Handle, session slot Some, Arc reused across list_folders + sync_folder"
    );

    // Clean shutdown so the keepalive task doesn't outlive the test (and best-
    // effort LOGOUT the live session). This also exercises `shutdown()` against
    // a real session — the only place that path can run end-to-end.
    manager.shutdown().await;
    let session_after_shutdown = stored.session.lock().await;
    assert!(
        session_after_shutdown.is_none(),
        "shutdown() must take() the session (leave None); got Some"
    );
    println!("[persistent-session] shutdown() took the session (None) + aborted keepalive");
}
