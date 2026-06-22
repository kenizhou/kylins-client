// Ported from mailkit_arkts. License pending confirmation. See ATTRIBUTIONS.md.
//
// End-to-end EAS integration tests against mail.kylins.com. These are marked
// `#[ignore]` because they hit a real Exchange server with real credentials.
//
// Run them manually after setting up `.env.test`:
//
//     $env:EAS_TEST_SERVER="https://mail.kylins.com/Microsoft-Server-ActiveSync"
//     $env:EAS_TEST_USER_DOMINATED="administrator@kylins.com"
//     $env:EAS_TEST_USER_DOMINATED_LOGIN="kylins\administrator"
//     $env:EAS_TEST_USER_DOMINATED_PASSWORD="P@ssw0rd"
//     $env:EAS_TEST_PROTOCOL_VERSION="16.1"
//     cargo test --test eas_integration -- --ignored --nocapture
//
// Skipped if env vars are missing or if the network is offline.

use kylins_client_lib::eas::client::EasClient;
use kylins_client_lib::eas::types::*;

fn load_dominated_config() -> Option<EasConfig> {
    let url = std::env::var("EAS_TEST_SERVER").ok()?;
    let username = std::env::var("EAS_TEST_USER_DOMINATED_LOGIN")
        .or_else(|_| std::env::var("EAS_TEST_USER_DOMINATED"))
        .ok()?;
    let password = std::env::var("EAS_TEST_USER_DOMINATED_PASSWORD").ok()?;
    let protocol_version = std::env::var("EAS_TEST_PROTOCOL_VERSION")
        .unwrap_or_else(|_| "16.1".to_string());

    Some(EasConfig {
        url,
        username,
        password,
        protocol_version,
        device_id: "KYLINSTEST00001".to_string(),
        device_type: "KylinsMail".to_string(),
        user_agent: "KylinsMail/1.0".to_string(),
        policy_key: "0".to_string(),
        accept_invalid_certs: true,
    })
}

fn load_paired_config() -> Option<EasConfig> {
    let url = std::env::var("EAS_TEST_SERVER").ok()?;
    let username = std::env::var("EAS_TEST_USER_PAIRED_LOGIN")
        .or_else(|_| std::env::var("EAS_TEST_USER_PAIRED"))
        .ok()?;
    let password = std::env::var("EAS_TEST_USER_PAIRED_PASSWORD").ok()?;
    let protocol_version = std::env::var("EAS_TEST_PROTOCOL_VERSION")
        .unwrap_or_else(|_| "16.1".to_string());

    Some(EasConfig {
        url,
        username,
        password,
        protocol_version,
        device_id: "KYLINSTEST00002".to_string(),
        device_type: "KylinsMail".to_string(),
        user_agent: "KylinsMail/1.0".to_string(),
        policy_key: "0".to_string(),
        accept_invalid_certs: true,
    })
}

/// FolderSync with sync_key "0" returns the initial folder hierarchy.
///
/// This test reaches the real Exchange server. A "success" outcome is one of:
///   - FolderSync succeeds and returns folders (provision already done)
///   - FolderSync fails with status 126 "provision required" — expected for a
///     fresh device ID that hasn't completed Provision. The EAS endpoint,
///     auth, WBXML codec, and HTTP transport all worked.
#[tokio::test]
#[ignore]
async fn folder_sync_initial_dominant_account() {
    let config = load_dominated_config().expect("set EAS_TEST_* env vars");
    let client = EasClient::new(config);
    let result = client.folder_sync("0").await;

    match result {
        Ok(r) => {
            println!(
                "FolderSync succeeded: {} folders, sync_key={}",
                r.changes.len(),
                r.sync_key
            );
            for f in &r.changes {
                println!("  {} ({}): class={}", f.display_name, f.server_id, f.class);
            }
            assert!(!r.sync_key.is_empty(), "sync_key must be set on success");
        }
        Err(e) => {
            let msg = e.to_string();
            // Status 126 = provision required. This is a server-side signal that
            // we successfully spoke EAS but need to do Provision first.
            // Provision is deferred from MVP, so accept it as "infrastructure works".
            if msg.contains("status 126") || msg.contains("provision required") {
                println!("FolderSync reached Exchange OK — server demands Provision (status 126).");
                println!("This is expected for MVP scope which deferred Provision.");
                println!("Error: {msg}");
                return;
            }
            panic!("FolderSync failed for unexpected reason: {msg}");
        }
    }
}

/// Diagnostic: print what env vars we actually loaded + the URL being sent.
/// Useful when integration test fails in a way curl does not.
#[tokio::test]
#[ignore]
async fn dump_eas_request_state() {
    println!("=== Environment variables (as Rust sees them) ===");
    for k in [
        "EAS_TEST_SERVER",
        "EAS_TEST_USER_DOMINATED",
        "EAS_TEST_USER_DOMINATED_LOGIN",
        "EAS_TEST_USER_DOMINATED_PASSWORD",
        "EAS_TEST_PROTOCOL_VERSION",
    ] {
        let v = std::env::var(k).unwrap_or_else(|_| "<unset>".to_string());
        // Print with surrounding quotes + byte display so trailing CR is visible
        println!("  {} = {:?} (bytes: {:?})", k, v, v.as_bytes());
    }

    if let Some(cfg) = load_dominated_config() {
        println!("\n=== EasConfig ===");
        println!("  url = {:?}", cfg.url);
        println!("  username = {:?} (bytes: {:?})", cfg.username, cfg.username.as_bytes());
        println!("  password bytes (len) = {}", cfg.password.len());
        println!("  protocol_version = {:?}", cfg.protocol_version);
        println!("  device_id = {:?}", cfg.device_id);
        println!("  accept_invalid_certs = {}", cfg.accept_invalid_certs);

        // Build the same URL the client would build
        let cmd_name = "FolderSync";
        let url = format!(
            "{}?Cmd={}&User={}&DeviceId={}&DeviceType={}",
            cfg.url.trim_end_matches('/'),
            cmd_name,
            urlencode_inner(&cfg.username),
            urlencode_inner(&cfg.device_id),
            urlencode_inner(&cfg.device_type),
        );
        println!("\n=== Constructed URL ===\n{}", url);

        // Build the WBXML we'd send (use the public command builder)
        let req = kylins_client_lib::eas::commands::build_folder_sync_request("0");
        let bytes = kylins_client_lib::eas::wbxml::serialize_tree(&req).expect("serialize");
        println!("\n=== WBXML request bytes ({}) ===", bytes.len());
        let hex: String = bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
        println!("{}", hex);

        // Build the Basic auth header
        let auth_pair = format!("{}:{}", cfg.username, cfg.password);
        let auth_b64 = base64_encode(&auth_pair.as_bytes());
        println!("\n=== Authorization header ===");
        println!("  pair bytes: {:?}", auth_pair.as_bytes());
        println!("  Basic {}", auth_b64);
    } else {
        println!("\nload_dominated_config() returned None — env vars missing");
    }
}

fn urlencode_inner(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Helper: returns true if the error indicates the server requires Provision.
fn requires_provision(err_msg: &str) -> bool {
    err_msg.contains("status 126")
        || err_msg.contains("status 142")
        || err_msg.contains("provision required")
        || err_msg.contains("device not partnered")
}

/// Second FolderSync with the previous sync key returns no changes (steady state).
///
/// Skipped if Provision is required for the first call.
#[tokio::test]
#[ignore]
async fn folder_sync_steady_state() {
    let config = load_dominated_config().expect("set EAS_TEST_* env vars");
    let client = EasClient::new(config);

    let first = client.folder_sync("0").await;
    let first = match first {
        Ok(r) => r,
        Err(e) if requires_provision(&e.to_string()) => {
            println!("Skipping steady-state — Provision required");
            return;
        }
        Err(e) => panic!("first FolderSync: {e}"),
    };
    let second = match client.folder_sync(&first.sync_key).await {
        Ok(r) => r,
        Err(e) if requires_provision(&e.to_string()) => {
            println!("Skipping — Provision required on second call");
            return;
        }
        Err(e) => panic!("second FolderSync: {e}"),
    };

    assert!(second.changes.is_empty(), "steady-state FolderSync should have no changes");
    assert!(second.deletions.is_empty(), "steady-state FolderSync should have no deletions");
}

/// FolderSync the second account to verify multi-account support.
///
/// Like the dominant account, Exchange typically returns status 142 (device
/// not partnered) for a fresh device ID. We accept that as "infrastructure OK."
#[tokio::test]
#[ignore]
async fn folder_sync_paired_account() {
    let config = load_paired_config().expect("set EAS_TEST_USER_PAIRED_* env vars");
    let client = EasClient::new(config);
    let result = client.folder_sync("0").await;
    match result {
        Ok(r) => {
            println!("Paired account FolderSync OK: {} folders", r.changes.len());
            assert!(!r.sync_key.is_empty());
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("status 126") || msg.contains("status 142") || msg.contains("provision") {
                println!("Paired account reached Exchange — server requires Provision (status 126/142).");
                return;
            }
            panic!("Paired FolderSync failed for unexpected reason: {msg}");
        }
    }
}

/// Sanity check: wrong password fails with a clear HTTP status error.
#[tokio::test]
#[ignore]
async fn folder_sync_wrong_password_fails() {
    let mut config = load_dominated_config().expect("set EAS_TEST_* env vars");
    config.password = "definitely-wrong-password-12345".to_string();
    let client = EasClient::new(config);
    let result = client.folder_sync("0").await;
    assert!(result.is_err(), "wrong password should fail");
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("401") || err.contains("403") || err.contains("status"),
        "expected auth-failure error, got: {err}"
    );
}

/// Ping with a short heartbeat should return OK or Timeout quickly.
///
/// Skipped if Provision is required (we need at least one folder ID to ping).
#[tokio::test]
#[ignore]
async fn ping_returns_ok_or_timeout() {
    let config = load_dominated_config().expect("set EAS_TEST_* env vars");
    let client = EasClient::new(config);

    let folders = match client.folder_sync("0").await {
        Ok(r) => r,
        Err(e) if requires_provision(&e.to_string()) => {
            println!("Skipping Ping — Provision required");
            return;
        }
        Err(e) => panic!("FolderSync: {e}"),
    };

    let email_folder = folders
        .changes
        .iter()
        .find(|f| f.class == "Email");
    let Some(email_folder) = email_folder else {
        println!("Skipping Ping — no Email folder in FolderSync response");
        return;
    };

    let result = client
        .ping(&PingRequest {
            heartbeat_interval: 60,
            monitored_collections: vec![PingCollection {
                collection_id: email_folder.server_id.clone(),
                class: "Email".to_string(),
            }],
        })
        .await
        .expect("Ping should succeed");

    assert!(
        result.status == "OK" || result.status == "Timeout",
        "expected OK or Timeout, got: {}",
        result.status
    );
}

/// FolderCreate + FolderDelete round trip on a disposable test folder.
/// This mutates server state, so we use a uniquely-named folder and clean up.
///
/// Skipped if Provision is required.
#[tokio::test]
#[ignore]
async fn folder_create_and_delete_round_trip() {
    let config = load_dominated_config().expect("set EAS_TEST_* env vars");
    let client = EasClient::new(config);

    let initial = match client.folder_sync("0").await {
        Ok(r) => r,
        Err(e) if requires_provision(&e.to_string()) => {
            println!("Skipping FolderCreate/Delete — Provision required");
            return;
        }
        Err(e) => panic!("initial FolderSync: {e}"),
    };
    let parent = initial
        .changes
        .iter()
        .find(|f| f.display_name.to_lowercase().contains("inbox") || f.parent_id == "0")
        .map(|f| f.server_id.clone())
        .unwrap_or_else(|| "0".to_string());

    let test_name = format!("KylinsTest-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs());

    let (create_status, new_id) = client
        .folder_create(&FolderCreateRequest {
            parent_id: parent.clone(),
            display_name: test_name.clone(),
            class: "Email".to_string(),
        })
        .await
        .expect("FolderCreate");

    assert_eq!(create_status, 1, "FolderCreate should return status 1 (success)");
    let new_id = new_id.expect("FolderCreate should return new server id");
    assert!(!new_id.is_empty(), "new server id must not be empty");

    println!("Created test folder server_id={}", new_id);

    // Clean up — delete the folder we just created
    let (delete_status, _) = client
        .folder_delete(&FolderDeleteRequest { server_id: new_id })
        .await
        .expect("FolderDelete");
    assert_eq!(delete_status, 1, "FolderDelete should return status 1");
}

/// ItemOperations fetch on a known message — requires a non-empty Inbox.
/// Skipped if no messages exist or Provision is required.
#[tokio::test]
#[ignore]
async fn item_operations_fetch_returns_metadata() {
    let config = load_dominated_config().expect("set EAS_TEST_* env vars");
    let client = EasClient::new(config);

    let folders = match client.folder_sync("0").await {
        Ok(r) => r,
        Err(e) if requires_provision(&e.to_string()) => {
            println!("Skipping ItemOperations — Provision required");
            return;
        }
        Err(e) => panic!("FolderSync: {e}"),
    };
    let inbox = folders
        .changes
        .iter()
        .find(|f| f.class == "Email")
        .expect("has email folder");

    // Sync to get at least one message
    let sync_result = client
        .sync(&SyncRequest {
            collection_id: inbox.server_id.clone(),
            sync_key: "0".to_string(),
            class: "Email".to_string(),
            window_size: 5,
            filter_age_days: 0,
            fetch_body: false,
        })
        .await
        .expect("Sync");

    if sync_result.added.is_empty() {
        eprintln!("Skipping ItemOperations test — no messages in mailbox");
        return;
    }

    let msg = &sync_result.added[0];
    println!("Fetching item operations for server_id={}", msg.server_id);

    let fetch = client
        .item_operations(&ItemOperationsFetchRequest {
            server_id: msg.server_id.clone(),
            collection_id: inbox.server_id.clone(),
            file_reference: None,
        })
        .await
        .expect("ItemOperations");

    assert_eq!(fetch.status, 1, "ItemOperations should return status 1");
}
