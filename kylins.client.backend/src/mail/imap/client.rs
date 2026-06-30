// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

use async_imap::{types::Flag, Authenticator, Client, Session};
use base64::Engine;
use futures::StreamExt;
use mail_parser::{MessageParser, MimeHeaders};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_native_tls::TlsStream;

use super::types::*;

/// Headers-only sync fetch query (RFC 3501 BODY.PEEK[HEADER.FIELDS]). Sync pulls
/// envelopes + flags + size — NOT full bodies — so async-imap can parse the small
/// responses and a 10K-message folder syncs in seconds instead of hanging on
/// full-body downloads. Bodies are fetched on demand via `fetch_message_body` /
/// `sync_request_bodies`.
///
/// The field list mirrors the spec for `parse_message`: addressing (`From`/`To`/
/// `Cc`/`Bcc`/`Reply-To`), threading (`Message-Id`/`In-Reply-To`/`References`),
/// list management (`List-Unsubscribe`/`List-Unsubscribe-Post`), and
/// `Authentication-Results` for phishing checks. `RFC822.SIZE` gives the UI the
/// on-wire size without a second round-trip.
pub const SYNC_FETCH_QUERY: &str =
    "UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO CC BCC REPLY-TO \
     DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST \
     AUTHENTICATION-RESULTS)]";

const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const IMAP_CMD_TIMEOUT: Duration = Duration::from_secs(30);
const IMAP_FETCH_TIMEOUT: Duration = Duration::from_secs(120);
const IMAP_SEARCH_TIMEOUT: Duration = Duration::from_secs(60);
const OVERALL_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

fn configure_tcp_socket(stream: &TcpStream) {
    if let Err(e) = stream.set_nodelay(true) {
        log::warn!("Failed to set TCP_NODELAY: {e}");
    }
    let sock_ref = socket2::SockRef::from(stream);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(60))
        .with_interval(Duration::from_secs(60));
    if let Err(e) = sock_ref.set_tcp_keepalive(&keepalive) {
        log::warn!("Failed to set TCP keepalive: {e}");
    }
}

struct XOAuth2 {
    response: Vec<u8>,
}

impl XOAuth2 {
    fn new(user: &str, access_token: &str) -> Self {
        let s = format!("user={}\x01auth=Bearer {}\x01\x01", user, access_token);
        Self {
            response: s.into_bytes(),
        }
    }
}

impl Authenticator for XOAuth2 {
    type Response = Vec<u8>;
    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        std::mem::take(&mut self.response)
    }
}

// One stream per IMAP connection; never stored in bulk, so the TLS/plain size
// difference is not a memory concern. Boxing the TLS variant would ripple
// through the AsyncRead/AsyncWrite Pin<P> impls for no real benefit here.
#[allow(clippy::large_enum_variant)]
pub enum ImapStream {
    Tls(TlsStream<TcpStream>),
    Plain(TcpStream),
}

impl tokio::io::AsyncRead for ImapStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for ImapStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_flush(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

impl std::fmt::Debug for ImapStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImapStream::Tls(_) => write!(f, "ImapStream::Tls"),
            ImapStream::Plain(_) => write!(f, "ImapStream::Plain"),
        }
    }
}

fn build_tls_connector(accept_invalid_certs: bool) -> Result<native_tls::TlsConnector, String> {
    let mut builder = native_tls::TlsConnector::builder();
    if accept_invalid_certs {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| format!("Failed to create TLS connector: {e}"))
}

type ImapSession = Session<ImapStream>;

pub async fn connect(config: &ImapConfig) -> Result<ImapSession, String> {
    tokio::time::timeout(OVERALL_CONNECT_TIMEOUT, connect_inner(config))
        .await
        .map_err(|_| format!(
            "IMAP connection to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, OVERALL_CONNECT_TIMEOUT.as_secs()
        ))?
}

async fn connect_inner(config: &ImapConfig) -> Result<ImapSession, String> {
    if config.security == "starttls" {
        return connect_starttls(config).await;
    }
    let stream = connect_stream(config).await?;
    let client = Client::new(stream);
    tokio::time::timeout(AUTH_TIMEOUT, authenticate(client, config))
        .await
        .map_err(|_| format!(
            "IMAP authentication timed out after {}s — check your server settings or network connection",
            AUTH_TIMEOUT.as_secs()
        ))?
}

pub async fn list_folders(session: &mut ImapSession) -> Result<Vec<ImapFolder>, String> {
    let names_stream = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.list(Some(""), Some("*")))
        .await
        .map_err(|_| {
            format!(
                "LIST timed out after {}s — check your server settings or network connection",
                IMAP_CMD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("LIST failed: {e}"))?;

    let names: Vec<_> = tokio::time::timeout(IMAP_CMD_TIMEOUT, names_stream.collect::<Vec<_>>())
        .await
        .map_err(|_| format!("LIST stream timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .into_iter()
        .filter_map(|r| r.ok())
        .collect();

    let mut folders = Vec::new();
    for name in &names {
        let raw_path = name.name().to_string();
        let delimiter = name.delimiter().unwrap_or("/").to_string();
        let path = utf7_imap::decode_utf7_imap(raw_path.clone());
        let display_name = path
            .rsplit_once(&delimiter)
            .map(|(_, last)| last.to_string())
            .unwrap_or_else(|| path.clone());
        let special_use = detect_special_use(name);
        let (exists, unseen) = match tokio::time::timeout(
            IMAP_CMD_TIMEOUT,
            session.status(&raw_path, "(MESSAGES UNSEEN)"),
        )
        .await
        {
            Ok(Ok(mailbox)) => (mailbox.exists, mailbox.unseen.unwrap_or(0)),
            _ => (0, 0),
        };
        folders.push(ImapFolder {
            path,
            raw_path,
            name: display_name,
            delimiter,
            special_use,
            exists,
            unseen,
        });
    }
    Ok(folders)
}

pub async fn fetch_messages(
    session: &mut ImapSession,
    folder: &str,
    uid_range: &str,
) -> Result<ImapFetchResult, String> {
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    log::info!(
        "IMAP SELECT {folder}: exists={}, uidvalidity={}, uidnext={}, fetching UIDs: {uid_range}",
        mailbox.exists,
        mailbox.uid_validity.unwrap_or(0),
        mailbox.uid_next.unwrap_or(0),
    );

    let fetches = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(uid_range, SYNC_FETCH_QUERY)
            .await
            .map_err(|e| format!("UID FETCH {folder} uids={uid_range} failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH {folder} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?;

    let raw_fetches: Vec<_> = fetches?;
    let mut fetch_ok = 0u32;
    let mut fetch_err = 0u32;
    let mut fetches = Vec::new();
    for r in raw_fetches {
        match r {
            Ok(f) => {
                fetch_ok += 1;
                fetches.push(f);
            }
            Err(e) => {
                fetch_err += 1;
                log::warn!("IMAP fetch stream error in {folder}: {e}");
            }
        }
    }
    log::info!("IMAP FETCH {folder}: {fetch_ok} ok, {fetch_err} errors from uid_fetch");

    if fetches.is_empty() && mailbox.exists > 0 {
        log::warn!("IMAP {folder}: async-imap returned 0 items but exists={}. Falling back to raw TCP fetch...", mailbox.exists);
        return Err(format!("ASYNC_IMAP_EMPTY:{folder}"));
    }

    let parser = MessageParser::default();
    let mut messages = Vec::new();
    for fetch in &fetches {
        let uid = match fetch.uid {
            Some(u) => u,
            None => {
                log::warn!("IMAP FETCH {folder}: response missing UID");
                continue;
            }
        };
        let raw = match fetch.body() {
            Some(b) => b,
            None => {
                log::warn!("IMAP FETCH {folder}: UID {uid} has no body");
                continue;
            }
        };
        // SYNC_FETCH_QUERY asks for RFC822.SIZE — prefer the server-reported
        // on-wire size (accurate; the body bytes here are header-only). Fall
        // back to the buffered length if the server omitted RFC822.SIZE.
        let raw_size = fetch.size.unwrap_or(raw.len() as u32);
        let flags: Vec<_> = fetch.flags().collect();
        let is_read = flags.iter().any(|f| matches!(f, Flag::Seen));
        let is_starred = flags.iter().any(|f| matches!(f, Flag::Flagged));
        let is_draft = flags.iter().any(|f| matches!(f, Flag::Draft));
        let internal_date = fetch.internal_date().map(|dt| dt.timestamp());
        match parse_message(
            &parser,
            raw,
            uid,
            folder,
            raw_size,
            is_read,
            is_starred,
            is_draft,
            internal_date,
        ) {
            Ok(msg) => messages.push(msg),
            Err(e) => log::warn!("Failed to parse message UID {uid}: {e}"),
        }
    }

    Ok(ImapFetchResult {
        messages,
        folder_status,
    })
}

pub async fn fetch_message_body(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
) -> Result<ImapMessage, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uid_str = uid.to_string();
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(&uid_str, "UID FLAGS BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH for UID {uid} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
    ?
    .into_iter()
    .filter_map(|r| r.ok())
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("Message UID {uid} not found in {folder}"))?;
    let raw = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {uid}"))?;
    let raw_size = raw.len() as u32;
    let flags: Vec<_> = fetch.flags().collect();
    let is_read = flags.iter().any(|f| matches!(f, Flag::Seen));
    let is_starred = flags.iter().any(|f| matches!(f, Flag::Flagged));
    let is_draft = flags.iter().any(|f| matches!(f, Flag::Draft));

    let parser = MessageParser::default();
    parse_message(
        &parser, raw, uid, folder, raw_size, is_read, is_starred, is_draft, None,
    )
}

pub async fn fetch_new_uids(
    session: &mut ImapSession,
    folder: &str,
    last_uid: u32,
) -> Result<Vec<u32>, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let query = format!("{}:*", last_uid + 1);
    let uids = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&query))
        .await
        .map_err(|_| {
            format!(
                "UID SEARCH timed out after {}s — check your server settings or network connection",
                IMAP_SEARCH_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("UID SEARCH failed: {e}"))?;

    let mut result: Vec<u32> = uids.into_iter().filter(|&u| u > last_uid).collect();
    result.sort();
    Ok(result)
}

/// A CONDSTORE flag-change entry: the server reported a FLAGS change for `uid`
/// at MODSEQ `modseq` since the last cursor. `is_read`/`is_starred` are the only
/// flags the UI tracks (Seen/Flagged). `modseq` is carried so the caller can pick
/// the next cursor.
#[derive(Debug, Clone)]
pub struct ImapFlagChange {
    pub uid: u32,
    pub is_read: bool,
    pub is_starred: bool,
    pub modseq: u64,
}

/// Pure reduction of parsed Fetch responses (from a CHANGEDSINCE round) into flag
/// changes plus the next modseq cursor. Factored out of `fetch_changed_flags` so
/// the mapping/cursor math is unit-testable without a live socket.
///
/// - `since_modseq`: the cursor we queried with; seeds the running max so an empty
///   response still yields a cursor >= the current one.
/// - `fetches`: `(uid, flags-as-strs, modseq)` tuples standing in for parsed
///   Fetches. Flags are owned `String`s so this function is lifetime-free and
///   callable from both the live path (which maps `Flag` → string) and tests.
/// - `mailbox_highest_modseq`: the mailbox's HIGHESTMODSEQ (from SELECT), so a
///   no-change round still advances to the server's current watermark.
///
/// Returns `(changes, next_modseq)` where `next_modseq = max(since, max(fetch
/// modseqs), mailbox_highest_modseq)`.
fn fetch_changed_flags_response_from_fetches(
    since_modseq: u64,
    fetches: Vec<(u32, Vec<String>, u64)>,
    mailbox_highest_modseq: u64,
) -> (Vec<ImapFlagChange>, u64) {
    let mut changes = Vec::new();
    let mut max_modseq = since_modseq;
    for (uid, flags, modseq) in fetches {
        if modseq > max_modseq {
            max_modseq = modseq;
        }
        let is_read = flags.iter().any(|f| f.eq_ignore_ascii_case("\\Seen"));
        let is_starred = flags.iter().any(|f| f.eq_ignore_ascii_case("\\Flagged"));
        changes.push(ImapFlagChange {
            uid,
            is_read,
            is_starred,
            modseq,
        });
    }
    (changes, max_modseq.max(mailbox_highest_modseq))
}

/// CONDSTORE flag-delta fetch (RFC 7162 §3.1). Returns messages whose metadata
/// changed since `since_modseq`, plus the next modseq cursor (max of returned
/// modseqs and the mailbox HIGHESTMODSEQ, so a no-change round still advances).
/// Requires the server to advertise CONDSTORE; the caller gates on
/// `caps.condstore && since_modseq > 0` (a first-sync modseq of 0 must NOT issue
/// CHANGEDSINCE — it would return every message as "changed").
///
/// Note: async-imap 0.10.4 exposes `Fetch.modseq` as a PUBLIC FIELD (`Option<u64>`),
/// not a method — `Fetch.flags()` IS a method (iterator). SELECT refreshes
/// `mailbox.highest_modseq`.
pub async fn fetch_changed_flags(
    session: &mut ImapSession,
    folder: &str,
    since_modseq: u64,
) -> Result<(Vec<ImapFlagChange>, u64), String> {
    // SELECT refreshes mailbox.highest_modseq (the server's current watermark).
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| {
            format!(
                "SELECT {folder} timed out after {}s — check your server settings or network connection",
                IMAP_CMD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;
    let mailbox_highest = mailbox.highest_modseq.unwrap_or(0);

    // CHANGEDSINCE is a modifier on the FETCH, not a separate command. The query
    // mirrors what the brief specifies: UID + FLAGS + the MODSEQ of each returned
    // message, scoped to messages changed since `since_modseq`.
    let query = format!("UID FLAGS MODSEQ (CHANGEDSINCE {since_modseq})");
    // The timeout wraps an async block whose body is `Result<Vec<Result<Fetch,
    // Error>>, String>` (the outer String = transport/timeout error; each inner
    // Result = one Fetch stream item). The two `?`s unwrap: (1) the timeout's
    // Elapsed, (2) the transport String. The remaining `Vec<Result<Fetch,_>>` is
    // iterated below — individual stream-item errors are logged, not fatal.
    let raw_fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch("1:*", &query)
            .await
            .map_err(|e| format!("UID FETCH CHANGEDSINCE {folder} failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| {
        format!(
            "UID FETCH CHANGEDSINCE {folder} timed out after {}s — check your server settings or network connection",
            IMAP_FETCH_TIMEOUT.as_secs()
        )
    })??
    .into_iter()
    .filter_map(|r| match r {
        Ok(f) => Some(f),
        Err(e) => {
            log::warn!("IMAP CHANGEDSINCE {folder}: fetch stream error: {e}");
            None
        }
    })
    .collect();

    // Reduce the parsed Fetches via the shared pure helper so the tested mapping
    // logic is exactly what runs in production (no divergent duplicate). Map each
    // `Flag` to its canonical backslash-string form; the helper matches
    // case-insensitively on "\\Seen"/"\\Flagged". Fetches without a UID are
    // skipped (CHANGEDSINCE responses always carry UID, but be defensive). Flag
    // strings are owned so the helper stays lifetime-free.
    let tuples: Vec<(u32, Vec<String>, u64)> = raw_fetches
        .into_iter()
        .filter_map(|f| {
            let uid = f.uid?;
            let flags: Vec<String> = f
                .flags()
                .map(|fl| match fl {
                    Flag::Seen => "\\Seen".to_string(),
                    Flag::Flagged => "\\Flagged".to_string(),
                    Flag::Answered => "\\Answered".to_string(),
                    Flag::Deleted => "\\Deleted".to_string(),
                    Flag::Draft => "\\Draft".to_string(),
                    Flag::Recent => "\\Recent".to_string(),
                    Flag::MayCreate => "\\*".to_string(),
                    Flag::Custom(s) => s.to_string(),
                })
                .collect();
            let ms = f.modseq.unwrap_or(0);
            Some((uid, flags, ms))
        })
        .collect();

    Ok(fetch_changed_flags_response_from_fetches(
        since_modseq,
        tuples,
        mailbox_highest,
    ))
}

pub async fn search_all_uids(session: &mut ImapSession, folder: &str) -> Result<Vec<u32>, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uids = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search("ALL"))
        .await
        .map_err(|_| format!("UID SEARCH ALL timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH ALL failed: {e}"))?;

    let mut result: Vec<u32> = uids.into_iter().collect();
    result.sort();
    Ok(result)
}

pub async fn set_flags(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
    flag_op: &str,
    flags: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let query = format!("{flag_op} {flags}");
    tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let stream = session
            .uid_store(uid_set, &query)
            .await
            .map_err(|e| format!("UID STORE failed: {e}"))?;
        let _: Vec<_> = stream.collect().await;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| {
        format!(
            "UID STORE timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        )
    })?
}

pub async fn move_messages(
    session: &mut ImapSession,
    source_folder: &str,
    uid_set: &str,
    dest_folder: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(source_folder))
        .await
        .map_err(|_| format!("SELECT {source_folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {source_folder} failed: {e}"))?;

    match tokio::time::timeout(IMAP_CMD_TIMEOUT, session.uid_mv(uid_set, dest_folder)).await {
        Ok(Ok(())) => Ok(()),
        _ => {
            tokio::time::timeout(IMAP_CMD_TIMEOUT, session.uid_copy(uid_set, dest_folder))
                .await
                .map_err(|_| format!("UID COPY timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
                .map_err(|e| format!("UID COPY failed: {e}"))?;

            tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
                let store_stream = session
                    .uid_store(uid_set, "+FLAGS (\\Deleted)")
                    .await
                    .map_err(|e| format!("UID STORE +Deleted failed: {e}"))?;
                let _: Vec<_> = store_stream.collect().await;
                Ok::<_, String>(())
            })
            .await
            .map_err(|_| format!("UID STORE +Deleted timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))??;

            tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
                let expunge_stream = session
                    .expunge()
                    .await
                    .map_err(|e| format!("EXPUNGE failed: {e}"))?;
                let _: Vec<_> = expunge_stream.collect().await;
                Ok::<_, String>(())
            })
            .await
            .map_err(|_| format!("EXPUNGE timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))??;
            Ok(())
        }
    }
}

pub async fn copy_messages(
    session: &mut ImapSession,
    source_folder: &str,
    uid_set: &str,
    dest_folder: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(source_folder))
        .await
        .map_err(|_| format!("SELECT {source_folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {source_folder} failed: {e}"))?;

    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.uid_copy(uid_set, dest_folder))
        .await
        .map_err(|_| {
            format!(
                "UID COPY timed out after {}s — check your server settings or network connection",
                IMAP_CMD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("UID COPY failed: {e}"))
}

pub async fn delete_messages(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let store_stream = session
            .uid_store(uid_set, "+FLAGS (\\Deleted)")
            .await
            .map_err(|e| format!("UID STORE +Deleted failed: {e}"))?;
        let _: Vec<_> = store_stream.collect().await;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| format!("UID STORE +Deleted timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))??;

    tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let expunge_stream = session
            .expunge()
            .await
            .map_err(|e| format!("EXPUNGE failed: {e}"))?;
        let _: Vec<_> = expunge_stream.collect().await;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| {
        format!(
            "EXPUNGE timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        )
    })??;

    Ok(())
}

pub async fn append_message(
    session: &mut ImapSession,
    folder: &str,
    flags: Option<&str>,
    raw_message: &[u8],
) -> Result<(), String> {
    tokio::time::timeout(
        IMAP_FETCH_TIMEOUT,
        session.append(folder, flags, None, raw_message),
    )
    .await
    .map_err(|_| {
        format!(
            "APPEND timed out after {}s — check your server settings or network connection",
            IMAP_FETCH_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("APPEND failed: {e}"))
}

pub async fn create_folder(session: &mut ImapSession, folder: &str) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.create(folder))
        .await
        .map_err(|_| {
            format!(
                "CREATE {folder} timed out after {}s — check your server settings or network connection",
                IMAP_CMD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("CREATE {folder} failed: {e}"))
}

pub async fn delete_folder(session: &mut ImapSession, folder: &str) -> Result<(), String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.delete(folder))
        .await
        .map_err(|_| {
            format!(
                "DELETE {folder} timed out after {}s — check your server settings or network connection",
                IMAP_CMD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("DELETE {folder} failed: {e}"))
}

pub async fn get_folder_status(
    session: &mut ImapSession,
    folder: &str,
) -> Result<ImapFolderStatus, String> {
    let mailbox = tokio::time::timeout(
        IMAP_CMD_TIMEOUT,
        session.status(folder, "(UIDVALIDITY UIDNEXT MESSAGES UNSEEN)"),
    )
    .await
    .map_err(|_| {
        format!(
            "STATUS timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("STATUS failed: {e}"))?;

    Ok(ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    })
}

pub async fn fetch_attachment(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
    part_id: &str,
) -> Result<String, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uid_str = uid.to_string();
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(&uid_str, "BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH attachment failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH attachment timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
    ?
    .into_iter()
    .filter_map(|r| r.ok())
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("No response for UID {uid}"))?;
    let raw = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {uid}"))?;

    let parser = MessageParser::default();
    let message = parser
        .parse(raw)
        .ok_or_else(|| format!("Failed to parse message UID {uid}"))?;

    let section_map = build_imap_section_map(&message);
    let target_part_idx = section_map
        .iter()
        .find(|(_, section)| section.as_str() == part_id)
        .map(|(&idx, _)| idx)
        .ok_or_else(|| format!("Section {part_id} not found in message UID {uid}"))?;

    let part = message
        .parts
        .get(target_part_idx)
        .ok_or_else(|| format!("Part index {target_part_idx} out of range for UID {uid}"))?;

    let data = match &part.body {
        mail_parser::PartType::Binary(data) | mail_parser::PartType::InlineBinary(data) => {
            data.as_ref().to_vec()
        }
        mail_parser::PartType::Text(text) => text.as_bytes().to_vec(),
        mail_parser::PartType::Html(html) => html.as_bytes().to_vec(),
        mail_parser::PartType::Message(msg) => msg.raw_message.as_ref().to_vec(),
        mail_parser::PartType::Multipart(_) => {
            return Err(format!(
                "Part {part_id} is a multipart container, not a leaf part"
            ));
        }
    };

    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

pub async fn fetch_raw_message(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
) -> Result<String, String> {
    tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let uid_str = uid.to_string();
    let fetches: Vec<_> = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(&uid_str, "BODY.PEEK[]")
            .await
            .map_err(|e| format!("UID FETCH failed: {e}"))?;
        Ok::<_, String>(stream.collect::<Vec<_>>().await)
    })
    .await
    .map_err(|_| format!("UID FETCH raw message timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?
    ?
    .into_iter()
    .filter_map(|r| r.ok())
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("Message UID {uid} not found in {folder}"))?;
    let raw = fetch
        .body()
        .ok_or_else(|| format!("No body for UID {uid}"))?;

    Ok(String::from_utf8_lossy(raw).to_string())
}

pub async fn delta_check_folders(
    session: &mut ImapSession,
    folders: &[DeltaCheckRequest],
) -> Result<Vec<DeltaCheckResult>, String> {
    let mut results = Vec::with_capacity(folders.len());

    for req in folders {
        let mailbox =
            match tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(&req.folder)).await {
                Ok(Ok(m)) => m,
                Ok(Err(e)) => {
                    log::warn!("delta_check: SELECT {} failed: {e}", req.folder);
                    continue;
                }
                Err(_) => {
                    log::warn!(
                        "delta_check: SELECT {} timed out after {}s",
                        req.folder,
                        IMAP_CMD_TIMEOUT.as_secs()
                    );
                    continue;
                }
            };

        let current_uidvalidity = mailbox.uid_validity.unwrap_or(0);
        let uidvalidity_changed = req.uidvalidity != 0 && current_uidvalidity != req.uidvalidity;

        if uidvalidity_changed {
            results.push(DeltaCheckResult {
                folder: req.folder.clone(),
                uidvalidity: current_uidvalidity,
                new_uids: vec![],
                uidvalidity_changed: true,
            });
            continue;
        }

        let query = format!("{}:*", req.last_uid + 1);
        let new_uids = match tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&query))
            .await
        {
            Ok(Ok(uids)) => {
                let mut result: Vec<u32> = uids.into_iter().filter(|&u| u > req.last_uid).collect();
                result.sort();
                result
            }
            Ok(Err(e)) => {
                log::warn!("delta_check: UID SEARCH {} failed: {e}", req.folder);
                vec![]
            }
            Err(_) => {
                log::warn!(
                    "delta_check: UID SEARCH {} timed out after {}s",
                    req.folder,
                    IMAP_SEARCH_TIMEOUT.as_secs()
                );
                vec![]
            }
        };

        results.push(DeltaCheckResult {
            folder: req.folder.clone(),
            uidvalidity: current_uidvalidity,
            new_uids,
            uidvalidity_changed: false,
        });
    }

    Ok(results)
}

pub async fn search_folder(
    session: &mut ImapSession,
    folder: &str,
    since_date: Option<String>,
) -> Result<ImapFolderSearchResult, String> {
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    let search_query = match &since_date {
        Some(date) => format!("SINCE {date}"),
        None => "ALL".to_string(),
    };
    let uids_raw = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&search_query))
        .await
        .map_err(|_| format!("UID SEARCH {search_query} {folder} timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH {search_query} {folder} failed: {e}"))?;

    let mut uids: Vec<u32> = uids_raw.into_iter().collect();
    uids.sort();

    log::info!(
        "IMAP search_folder {folder}: {} UIDs found (search={search_query}), uidvalidity={}",
        uids.len(),
        folder_status.uidvalidity,
    );

    Ok(ImapFolderSearchResult {
        uids,
        folder_status,
    })
}

pub async fn sync_folder(
    session: &mut ImapSession,
    folder: &str,
    batch_size: u32,
    since_date: Option<String>,
) -> Result<ImapFolderSyncResult, String> {
    let mailbox = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.select(folder))
        .await
        .map_err(|_| format!("SELECT {folder} timed out after {}s — check your server settings or network connection", IMAP_CMD_TIMEOUT.as_secs()))?
        .map_err(|e| format!("SELECT {folder} failed: {e}"))?;

    let folder_status = ImapFolderStatus {
        uidvalidity: mailbox.uid_validity.unwrap_or(0),
        uidnext: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq: mailbox.highest_modseq,
    };

    let search_query = match &since_date {
        Some(date) => format!("SINCE {date}"),
        None => "ALL".to_string(),
    };
    let uids_raw = tokio::time::timeout(IMAP_SEARCH_TIMEOUT, session.uid_search(&search_query))
        .await
        .map_err(|_| format!("UID SEARCH {search_query} {folder} timed out after {}s — check your server settings or network connection", IMAP_SEARCH_TIMEOUT.as_secs()))?
        .map_err(|e| format!("UID SEARCH {search_query} {folder} failed: {e}"))?;

    let mut uids: Vec<u32> = uids_raw.into_iter().collect();
    uids.sort();

    log::info!(
        "IMAP sync_folder {folder}: {} UIDs found (search={search_query}), uidvalidity={}, batch_size={}",
        uids.len(),
        folder_status.uidvalidity,
        batch_size,
    );

    if uids.is_empty() {
        return Ok(ImapFolderSyncResult {
            uids,
            messages: vec![],
            folder_status,
        });
    }

    let parser = MessageParser::default();
    let mut all_messages = Vec::new();
    let bs = batch_size as usize;

    for chunk in uids.chunks(bs) {
        let uid_set: String = chunk
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let fetches = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
            let stream = session
                .uid_fetch(&uid_set, "UID FLAGS INTERNALDATE BODY.PEEK[]")
                .await
                .map_err(|e| format!("UID FETCH {folder} uids={uid_set} failed: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        })
        .await
        .map_err(|_| format!("UID FETCH {folder} timed out after {}s — check your server settings or network connection", IMAP_FETCH_TIMEOUT.as_secs()))?;

        let raw_fetches: Vec<_> = fetches?;
        for r in raw_fetches {
            match r {
                Ok(f) => {
                    let uid = match f.uid {
                        Some(u) => u,
                        None => {
                            log::warn!("IMAP sync_folder {folder}: response missing UID");
                            continue;
                        }
                    };
                    let raw = match f.body() {
                        Some(b) => b,
                        None => {
                            log::warn!("IMAP sync_folder {folder}: UID {uid} has no body");
                            continue;
                        }
                    };
                    let raw_size = raw.len() as u32;
                    let flags: Vec<_> = f.flags().collect();
                    let is_read = flags.iter().any(|fl| matches!(fl, Flag::Seen));
                    let is_starred = flags.iter().any(|fl| matches!(fl, Flag::Flagged));
                    let is_draft = flags.iter().any(|fl| matches!(fl, Flag::Draft));
                    let internal_date = f.internal_date().map(|dt| dt.timestamp());

                    match parse_message(
                        &parser,
                        raw,
                        uid,
                        folder,
                        raw_size,
                        is_read,
                        is_starred,
                        is_draft,
                        internal_date,
                    ) {
                        Ok(msg) => all_messages.push(msg),
                        Err(e) => log::warn!("sync_folder: failed to parse UID {uid}: {e}"),
                    }
                }
                Err(e) => log::warn!("IMAP sync_folder fetch stream error in {folder}: {e}"),
            }
        }
    }

    log::info!(
        "IMAP sync_folder {folder}: fetched {} messages",
        all_messages.len()
    );

    Ok(ImapFolderSyncResult {
        uids,
        messages: all_messages,
        folder_status,
    })
}

pub async fn test_connection(config: &ImapConfig) -> Result<String, String> {
    let mut session = connect(config).await?;
    let count = tokio::time::timeout(IMAP_CMD_TIMEOUT, async {
        let names = session
            .list(Some(""), Some("*"))
            .await
            .map_err(|e| format!("LIST failed: {e}"))?;
        Ok::<_, String>(names.collect::<Vec<_>>().await.len())
    })
    .await
    .map_err(|_| {
        format!(
            "LIST timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        )
    })??;

    let _ = tokio::time::timeout(IMAP_CMD_TIMEOUT, session.logout()).await;

    Ok(format!(
        "Connected successfully. Found {} folder(s).",
        count
    ))
}

pub async fn raw_fetch_messages(
    config: &ImapConfig,
    folder: &str,
    uid_range: &str,
) -> Result<ImapFetchResult, String> {
    log::info!(
        "RAW IMAP FETCH: connecting to {}:{} for folder {folder}, UIDs {uid_range}",
        config.host,
        config.port
    );

    let stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };

    let mut reader = BufReader::new(stream);

    if config.security != "starttls" {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("greeting: {e}"))?;
    }

    let login_cmd = if config.auth_method == "oauth2" {
        let xoauth2 = format!(
            "user={}\x01auth=Bearer {}\x01\x01",
            config.username, config.password
        );
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            xoauth2.as_bytes(),
        );
        format!("a1 AUTHENTICATE XOAUTH2 {b64}\r\n")
    } else {
        format!(
            "a1 LOGIN \"{}\" \"{}\"\r\n",
            config.username, config.password
        )
    };
    raw_send_and_wait(&mut reader, login_cmd.as_bytes(), "a1").await?;

    let select_cmd = format!("a2 SELECT \"{folder}\"\r\n");
    let select_response = raw_send_and_wait(&mut reader, select_cmd.as_bytes(), "a2").await?;

    let mut exists = 0u32;
    let mut uidvalidity = 0u32;
    let mut unseen = 0u32;
    for line in select_response.lines() {
        if let Some(n) = parse_untagged_number(line, "EXISTS") {
            exists = n;
        }
        if line.contains("[UIDVALIDITY") {
            if let Some(v) = extract_bracket_number(line, "UIDVALIDITY") {
                uidvalidity = v;
            }
        }
        if line.contains("[UNSEEN") {
            if let Some(v) = extract_bracket_number(line, "UNSEEN") {
                unseen = v;
            }
        }
    }

    let folder_status = ImapFolderStatus {
        uidvalidity,
        uidnext: 0,
        exists,
        unseen,
        highest_modseq: None,
    };

    // Headers-only, mirroring SYNC_FETCH_QUERY. The raw-TCP fallback exists
    // because async-imap 0.10 silently returns 0 items on very large bodies;
    // keeping the same field set as the primary path means a fallback behaves
    // consistently (no surprise full-body downloads, no re-introduced hang).
    let fetch_cmd = format!("a3 UID FETCH {uid_range} ({SYNC_FETCH_QUERY})\r\n");
    reader
        .get_mut()
        .write_all(fetch_cmd.as_bytes())
        .await
        .map_err(|e| format!("FETCH write: {e}"))?;

    let raw_messages = raw_parse_fetch_responses(&mut reader, "a3").await?;

    log::info!(
        "RAW IMAP FETCH {folder}: parsed {} raw messages",
        raw_messages.len()
    );

    let parser = MessageParser::default();
    let mut messages = Vec::new();

    for raw_msg in &raw_messages {
        match parse_message(
            &parser,
            &raw_msg.body,
            raw_msg.uid,
            folder,
            raw_msg.body.len() as u32,
            raw_msg.is_read,
            raw_msg.is_starred,
            raw_msg.is_draft,
            raw_msg.internal_date,
        ) {
            Ok(msg) => messages.push(msg),
            Err(e) => log::warn!("RAW FETCH: failed to parse UID {}: {e}", raw_msg.uid),
        }
    }

    let _ = reader.get_mut().write_all(b"a4 LOGOUT\r\n").await;

    Ok(ImapFetchResult {
        messages,
        folder_status,
    })
}

/// One-connection bulk fetch: connect + login + SELECT once, then UID FETCH each
/// chunk of `uids` on the SAME raw connection. Avoids the per-chunk reconnect
/// storm that `raw_fetch_messages` triggers when `async-imap`'s `uid_fetch`
/// returns 0 items on a server (parser incompatibility) and forces the whole
/// folder through the raw fallback — ~31 rapid reconnects for a 3133-message
/// folder trips the server's connection/flood limit (`* BYE Connection closed.
/// 14`), which errors mid-folder and drops the delta.
///
/// Best-effort: if a chunk errors mid-way (server drops the connection), logs
/// the detail and returns what was fetched so far — the caller's cursor still
/// advances past the UIDs it got, breaking the infinite-retry-from-same-UID
/// loop. The caller passes the WHOLE folder's pending UIDs; this function owns
/// the single connection lifecycle end-to-end.
pub async fn raw_fetch_folder(
    config: &ImapConfig,
    folder: &str,
    uids: &[u32],
    chunk_size: usize,
) -> Result<ImapFetchResult, String> {
    if uids.is_empty() {
        // Nothing to do; report a zero-status so callers can still advance.
        return Ok(ImapFetchResult {
            messages: vec![],
            folder_status: ImapFolderStatus {
                uidvalidity: 0,
                uidnext: 0,
                exists: 0,
                unseen: 0,
                highest_modseq: None,
            },
        });
    }

    log::info!(
        "RAW IMAP FETCH FOLDER: connecting to {}:{} for {folder}, {} UID(s) in chunks of {chunk_size}",
        config.host,
        config.port,
        uids.len()
    );

    // 1. connect (+ read greeting for plain/tls; STARTTLS path consumes it
    //    during handshake) — mirrors raw_fetch_messages exactly.
    let stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };
    let mut reader = BufReader::new(stream);

    if config.security != "starttls" {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("greeting: {e}"))?;
    }

    // 2. login (LOGIN vs XOAUTH2, same cmd shape as raw_fetch_messages).
    let login_cmd = if config.auth_method == "oauth2" {
        let xoauth2 = format!(
            "user={}\x01auth=Bearer {}\x01\x01",
            config.username, config.password
        );
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            xoauth2.as_bytes(),
        );
        format!("a1 AUTHENTICATE XOAUTH2 {b64}\r\n")
    } else {
        format!(
            "a1 LOGIN \"{}\" \"{}\"\r\n",
            config.username, config.password
        )
    };
    raw_send_and_wait(&mut reader, login_cmd.as_bytes(), "a1").await?;

    // 3. SELECT once for the whole folder.
    let select_cmd = format!("a2 SELECT \"{folder}\"\r\n");
    let select_response = raw_send_and_wait(&mut reader, select_cmd.as_bytes(), "a2").await?;

    let mut exists = 0u32;
    let mut uidvalidity = 0u32;
    let mut unseen = 0u32;
    for line in select_response.lines() {
        if let Some(n) = parse_untagged_number(line, "EXISTS") {
            exists = n;
        }
        if line.contains("[UIDVALIDITY") {
            if let Some(v) = extract_bracket_number(line, "UIDVALIDITY") {
                uidvalidity = v;
            }
        }
        if line.contains("[UNSEEN") {
            if let Some(v) = extract_bracket_number(line, "UNSEEN") {
                unseen = v;
            }
        }
    }

    let folder_status = ImapFolderStatus {
        uidvalidity,
        uidnext: 0,
        exists,
        unseen,
        highest_modseq: None,
    };

    // 4. UID FETCH each chunk on the SAME connection. Fresh IMAP tag per chunk
    //    (a3, a4, ...). On error: log the detail + break, returning what we have
    //    so the caller's cursor still advances past fetched UIDs.
    let parser = MessageParser::default();
    let mut messages: Vec<ImapMessage> = Vec::new();
    let chunks: Vec<&[u32]> = uids.chunks(chunk_size).collect();
    let mut tag_index = 3u32;

    for (i, chunk) in chunks.iter().enumerate() {
        let range = uid_set_raw(chunk);
        let tag = format!("a{tag_index}");
        let fetch_cmd = format!("{tag} UID FETCH {range} ({SYNC_FETCH_QUERY})\r\n");

        if let Err(e) = reader
            .get_mut()
            .write_all(fetch_cmd.as_bytes())
            .await
        {
            log::warn!(
                "[sync] raw fetch {folder} chunk {} (uids {range}): write failed: {e}; returning {} fetched so far",
                i + 1,
                messages.len()
            );
            break;
        }

        match raw_parse_fetch_responses(&mut reader, &tag).await {
            Ok(raw_messages) => {
                log::info!(
                    "RAW IMAP FETCH FOLDER {folder} chunk {} (uids {range}): parsed {} raw messages",
                    i + 1,
                    raw_messages.len()
                );
                for raw_msg in &raw_messages {
                    match parse_message(
                        &parser,
                        &raw_msg.body,
                        raw_msg.uid,
                        folder,
                        raw_msg.body.len() as u32,
                        raw_msg.is_read,
                        raw_msg.is_starred,
                        raw_msg.is_draft,
                        raw_msg.internal_date,
                    ) {
                        Ok(msg) => messages.push(msg),
                        Err(e) => log::warn!(
                            "RAW FETCH FOLDER {folder}: failed to parse UID {}: {e}",
                            raw_msg.uid
                        ),
                    }
                }
            }
            Err(e) => {
                // Best-effort mid-folder: connection closed / read failure / etc.
                // Log the DETAIL (e.g. "Connection closed during FETCH" /
                // "FETCH read: ...") so the root cause (BYE) is captured.
                log::warn!(
                    "[sync] raw fetch {folder} chunk {} (uids {range}) failed: {e}; returning {} fetched so far",
                    i + 1,
                    messages.len()
                );
                break;
            }
        }

        tag_index = tag_index.saturating_add(1);
    }

    // 5. best-effort LOGOUT (ignore errors — connection may already be closed).
    let _ = reader.get_mut().write_all(b"LOGOUT\r\n").await;

    log::info!(
        "RAW IMAP FETCH FOLDER {folder}: {}/{} UID(s) fetched across {} chunk(s)",
        messages.len(),
        uids.len(),
        chunks.len()
    );

    Ok(ImapFetchResult {
        messages,
        folder_status,
    })
}

/// Local comma-join of UIDs for the raw FETCH command (mirrors sync_engine's
/// `uid_set` but kept private to this module so the raw path is self-contained).
fn uid_set_raw(uids: &[u32]) -> String {
    uids.iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

pub async fn raw_fetch_diagnostic(
    config: &ImapConfig,
    folder: &str,
    uid_range: &str,
) -> Result<String, String> {
    let mut stream = if config.security == "starttls" {
        raw_connect_starttls(config).await?
    } else {
        connect_stream(config).await?
    };

    let mut buf = vec![0u8; 16384];
    let mut output = String::new();

    if config.security != "starttls" {
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| format!("greeting: {e}"))?;
        output.push_str(&format!("S: {}", String::from_utf8_lossy(&buf[..n])));
    }

    let login_cmd = format!(
        "a1 LOGIN \"{}\" \"{}\"\r\n",
        config.username, config.password
    );
    stream
        .write_all(login_cmd.as_bytes())
        .await
        .map_err(|e| format!("LOGIN: {e}"))?;
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("LOGIN read: {e}"))?;
    output.push_str(&format!("S: {}", String::from_utf8_lossy(&buf[..n])));

    let select_cmd = format!("a2 SELECT \"{folder}\"\r\n");
    stream
        .write_all(select_cmd.as_bytes())
        .await
        .map_err(|e| format!("SELECT: {e}"))?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("SELECT read: {e}"))?;
    output.push_str(&format!("S: {}", String::from_utf8_lossy(&buf[..n])));

    let fetch_cmd = format!("a3 UID FETCH {uid_range} (UID FLAGS)\r\n");
    stream
        .write_all(fetch_cmd.as_bytes())
        .await
        .map_err(|e| format!("FETCH: {e}"))?;

    let mut fetch_response = String::new();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        match tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                fetch_response.push_str(&String::from_utf8_lossy(&buf[..n]));
                if fetch_response.contains("a3 OK")
                    || fetch_response.contains("a3 NO")
                    || fetch_response.contains("a3 BAD")
                {
                    break;
                }
            }
            Ok(Err(e)) => {
                fetch_response.push_str(&format!("[read error: {e}]"));
                break;
            }
            Err(_) => {
                fetch_response.push_str("[timeout]");
                break;
            }
        }
    }
    output.push_str(&format!("FETCH response:\n{fetch_response}"));

    let _ = stream.write_all(b"a4 LOGOUT\r\n").await;

    log::info!("RAW IMAP DIAGNOSTIC for {folder}:\n{output}");

    Ok(output)
}

// ---------- Raw TCP helpers ----------

struct RawFetchedMessage {
    uid: u32,
    is_read: bool,
    is_starred: bool,
    is_draft: bool,
    internal_date: Option<i64>,
    body: Vec<u8>,
}

async fn raw_connect_starttls(config: &ImapConfig) -> Result<ImapStream, String> {
    let addr = (&*config.host, config.port);
    let mut tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| format!(
            "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TCP: {e}"))?;
    configure_tcp_socket(&tcp);
    let mut tmp = vec![0u8; 4096];
    let _ = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut tmp)).await;
    tcp.write_all(b"a0 STARTTLS\r\n")
        .await
        .map_err(|e| format!("STARTTLS: {e}"))?;
    let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut tmp))
        .await
        .map_err(|_| format!(
            "STARTTLS response timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("STARTTLS resp: {e}"))?;
    let resp = String::from_utf8_lossy(&tmp[..n]);
    if !resp.contains("OK") {
        return Err(format!("STARTTLS rejected: {resp}"));
    }
    let nc = build_tls_connector(config.accept_invalid_certs)?;
    let tc = tokio_native_tls::TlsConnector::from(nc);
    let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tc.connect(&config.host, tcp))
        .await
        .map_err(|_| {
            format!(
            "TLS handshake timed out after {}s — check your server settings or network connection",
            TLS_HANDSHAKE_TIMEOUT.as_secs()
        )
        })?
        .map_err(|e| format!("TLS: {e}"))?;
    Ok(ImapStream::Tls(tls))
}

async fn raw_send_and_wait(
    reader: &mut tokio::io::BufReader<ImapStream>,
    cmd: &[u8],
    tag: &str,
) -> Result<String, String> {
    reader
        .get_mut()
        .write_all(cmd)
        .await
        .map_err(|e| format!("{tag} write: {e}"))?;

    let mut response = String::new();
    let tag_ok = format!("{tag} OK");
    let tag_no = format!("{tag} NO");
    let tag_bad = format!("{tag} BAD");

    loop {
        let mut line = String::new();
        match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            reader.read_line(&mut line),
        )
        .await
        {
            Ok(Ok(0)) => return Err(format!("{tag}: connection closed")),
            Ok(Ok(_)) => {
                response.push_str(&line);
                if line.starts_with(&tag_ok) {
                    return Ok(response);
                }
                if line.starts_with(&tag_no) || line.starts_with(&tag_bad) {
                    return Err(format!("{tag} failed: {line}"));
                }
            }
            Ok(Err(e)) => return Err(format!("{tag} read: {e}")),
            Err(_) => return Err(format!("{tag}: timeout")),
        }
    }
}

fn parse_untagged_number(line: &str, keyword: &str) -> Option<u32> {
    let trimmed = line.trim();
    if !trimmed.starts_with("* ") || !trimmed.ends_with(keyword) {
        return None;
    }
    let middle = trimmed[2..trimmed.len() - keyword.len()].trim();
    middle.parse().ok()
}

fn extract_bracket_number(line: &str, keyword: &str) -> Option<u32> {
    let pattern = format!("[{keyword} ");
    if let Some(start) = line.find(&pattern) {
        let after = &line[start + pattern.len()..];
        if let Some(end) = after.find(']') {
            return after[..end].trim().parse().ok();
        }
    }
    None
}

async fn raw_parse_fetch_responses(
    reader: &mut tokio::io::BufReader<ImapStream>,
    tag: &str,
) -> Result<Vec<RawFetchedMessage>, String> {
    let mut messages: Vec<RawFetchedMessage> = Vec::new();
    let tag_ok = format!("{tag} OK");
    let tag_no = format!("{tag} NO");
    let tag_bad = format!("{tag} BAD");

    loop {
        let mut line = String::new();
        match tokio::time::timeout(
            std::time::Duration::from_secs(60),
            reader.read_line(&mut line),
        )
        .await
        {
            Ok(Ok(0)) => return Err("Connection closed during FETCH".to_string()),
            Ok(Ok(_)) => {
                if line.starts_with(&tag_ok) {
                    break;
                }
                if line.starts_with(&tag_no) || line.starts_with(&tag_bad) {
                    return Err(format!("FETCH failed: {line}"));
                }

                if !line.starts_with("* ") || !line.contains("FETCH") {
                    continue;
                }

                let uid = extract_fetch_uid(&line).unwrap_or(0);
                if uid == 0 {
                    log::warn!("RAW FETCH: could not parse UID from: {}", line.trim());
                    if let Some(literal_size) = extract_literal_size(&line) {
                        let mut discard = vec![0u8; literal_size];
                        reader
                            .read_exact(&mut discard)
                            .await
                            .map_err(|e| format!("discard literal: {e}"))?;
                    }
                    continue;
                }

                let flags_str = extract_flags_from_fetch(&line);
                let is_read = flags_str.contains("\\Seen");
                let is_starred = flags_str.contains("\\Flagged");
                let is_draft = flags_str.contains("\\Draft");

                let internal_date = extract_internal_date(&line);

                if let Some(literal_size) = extract_literal_size(&line) {
                    let mut body = vec![0u8; literal_size];
                    reader
                        .read_exact(&mut body)
                        .await
                        .map_err(|e| format!("read literal for UID {uid}: {e}"))?;

                    let mut closing = String::new();
                    let _ = reader.read_line(&mut closing).await;

                    messages.push(RawFetchedMessage {
                        uid,
                        is_read,
                        is_starred,
                        is_draft,
                        internal_date,
                        body,
                    });
                }
            }
            Ok(Err(e)) => return Err(format!("FETCH read: {e}")),
            Err(_) => return Err("FETCH timeout".to_string()),
        }
    }

    Ok(messages)
}

fn extract_fetch_uid(line: &str) -> Option<u32> {
    let uid_idx = line.find("UID ")?;
    let after_uid = &line[uid_idx + 4..];
    let end = after_uid
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(after_uid.len());
    after_uid[..end].parse().ok()
}

fn extract_flags_from_fetch(line: &str) -> String {
    if let Some(flags_start) = line.find("FLAGS (") {
        let after = &line[flags_start + 7..];
        if let Some(end) = after.find(')') {
            return after[..end].to_string();
        }
    }
    String::new()
}

fn extract_internal_date(line: &str) -> Option<i64> {
    let idx = line.find("INTERNALDATE \"")?;
    let after = &line[idx + 14..];
    let end = after.find('"')?;
    let date_str = &after[..end];
    parse_imap_date(date_str)
}

fn parse_imap_date(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }

    let date_parts: Vec<&str> = parts[0].split('-').collect();
    if date_parts.len() != 3 {
        return None;
    }

    let day: u32 = date_parts[0].parse().ok()?;
    let month = match date_parts[1].to_lowercase().as_str() {
        "jan" => 1u32,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    };
    let year: i64 = date_parts[2].parse().ok()?;

    let time_parts: Vec<&str> = parts.get(1)?.split(':').collect();
    if time_parts.len() != 3 {
        return None;
    }
    let hour: i64 = time_parts[0].parse().ok()?;
    let minute: i64 = time_parts[1].parse().ok()?;
    let second: i64 = time_parts[2].parse().ok()?;

    let tz_offset_secs: i64 = if let Some(tz) = parts.get(2) {
        let sign = if tz.starts_with('-') { -1i64 } else { 1i64 };
        let tz_num = tz.trim_start_matches(['+', '-']);
        if tz_num.len() == 4 {
            let tz_h: i64 = tz_num[..2].parse().unwrap_or(0);
            let tz_m: i64 = tz_num[2..].parse().unwrap_or(0);
            sign * (tz_h * 3600 + tz_m * 60)
        } else {
            0
        }
    } else {
        0
    };

    let mut days: i64 = 0;
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }
    let month_days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..month {
        days += month_days[m as usize] as i64;
        if m == 2 && is_leap_year(year) {
            days += 1;
        }
    }
    days += day as i64 - 1;

    Some(days * 86400 + hour * 3600 + minute * 60 + second - tz_offset_secs)
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn extract_literal_size(line: &str) -> Option<usize> {
    let trimmed = line.trim_end();
    if !trimmed.ends_with('}') {
        return None;
    }
    let brace_start = trimmed.rfind('{')?;
    trimmed[brace_start + 1..trimmed.len() - 1].parse().ok()
}

async fn connect_stream(config: &ImapConfig) -> Result<ImapStream, String> {
    let addr = (&*config.host, config.port);

    match config.security.as_str() {
        "tls" => {
            let native_connector = build_tls_connector(config.accept_invalid_certs)?;
            let tls_connector = tokio_native_tls::TlsConnector::from(native_connector);
            let tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
                .await
                .map_err(|_| format!(
                    "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
                    config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
                ))?
                .map_err(|e| format!("TCP connect to {}:{} failed: {e}", config.host, config.port))?;
            configure_tcp_socket(&tcp);
            let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tls_connector.connect(&config.host, tcp))
                .await
                .map_err(|_| format!(
                    "TLS handshake with {} timed out after {}s — check your server settings or network connection",
                    config.host, TLS_HANDSHAKE_TIMEOUT.as_secs()
                ))?
                .map_err(|e| format!("TLS handshake with {} failed: {e}", config.host))?;
            Ok(ImapStream::Tls(tls))
        }
        "none" => {
            let tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
                .await
                .map_err(|_| format!(
                    "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
                    config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
                ))?
                .map_err(|e| format!("TCP connect to {}:{} failed: {e}", config.host, config.port))?;
            configure_tcp_socket(&tcp);
            Ok(ImapStream::Plain(tcp))
        }
        other => Err(format!(
            "Unknown security mode: {other}. Use \"tls\", \"starttls\", or \"none\"."
        )),
    }
}

async fn connect_starttls(config: &ImapConfig) -> Result<ImapSession, String> {
    let addr = (&*config.host, config.port);
    let mut tcp = tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| format!(
            "TCP connect to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, TCP_CONNECT_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TCP connect to {}:{} failed: {e}", config.host, config.port))?;
    configure_tcp_socket(&tcp);

    let mut buf = vec![0u8; 4096];
    let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut buf))
        .await
        .map_err(|_| format!(
            "Reading server greeting timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("Failed to read server greeting: {e}"))?;
    let greeting = String::from_utf8_lossy(&buf[..n]);
    if !greeting.contains("OK") {
        return Err(format!("Unexpected server greeting: {greeting}"));
    }

    tcp.write_all(b"a001 STARTTLS\r\n")
        .await
        .map_err(|e| format!("Failed to send STARTTLS: {e}"))?;

    let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, tcp.read(&mut buf))
        .await
        .map_err(|_| format!(
            "STARTTLS response timed out after {}s — check your server settings or network connection",
            IMAP_CMD_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("Failed to read STARTTLS response: {e}"))?;
    let response = String::from_utf8_lossy(&buf[..n]);
    if !response.contains("OK") {
        return Err(format!("STARTTLS rejected: {response}"));
    }

    let native_connector = build_tls_connector(config.accept_invalid_certs)?;
    let tls_connector = tokio_native_tls::TlsConnector::from(native_connector);
    let tls = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, tls_connector.connect(&config.host, tcp))
        .await
        .map_err(|_| format!(
            "TLS upgrade after STARTTLS timed out after {}s — check your server settings or network connection",
            TLS_HANDSHAKE_TIMEOUT.as_secs()
        ))?
        .map_err(|e| format!("TLS upgrade after STARTTLS failed: {e}"))?;

    let client = Client::new(ImapStream::Tls(tls));
    tokio::time::timeout(AUTH_TIMEOUT, authenticate(client, config))
        .await
        .map_err(|_| format!(
            "IMAP authentication timed out after {}s — check your server settings or network connection",
            AUTH_TIMEOUT.as_secs()
        ))?
}

async fn authenticate(
    client: Client<ImapStream>,
    config: &ImapConfig,
) -> Result<ImapSession, String> {
    match config.auth_method.as_str() {
        "oauth2" => {
            let auth = XOAuth2::new(&config.username, &config.password);
            client
                .authenticate("XOAUTH2", auth)
                .await
                .map_err(|(e, _)| format!("XOAUTH2 authentication failed: {e}"))
        }
        _ => client
            .login(&config.username, &config.password)
            .await
            .map_err(|(e, _)| format!("Login failed: {e}")),
    }
}

fn detect_special_use(name: &async_imap::types::Name) -> Option<String> {
    use async_imap::types::NameAttribute;

    for attr in name.attributes() {
        let special = match attr {
            NameAttribute::Sent => Some("\\Sent"),
            NameAttribute::Trash => Some("\\Trash"),
            NameAttribute::Drafts => Some("\\Drafts"),
            NameAttribute::Junk => Some("\\Junk"),
            NameAttribute::Archive => Some("\\Archive"),
            NameAttribute::All => Some("\\All"),
            NameAttribute::Flagged => Some("\\Flagged"),
            _ => None,
        };
        if let Some(s) = special {
            return Some(s.to_string());
        }
    }

    let lower = name.name().to_lowercase();
    match lower.as_str() {
        "inbox" => Some("\\Inbox".to_string()),
        "sent" | "sent messages" | "sent items" | "[gmail]/sent mail" => Some("\\Sent".to_string()),
        "trash" | "deleted" | "deleted items" | "deleted messages" | "bin" | "corbeille"
        | "unsolbox" | "[gmail]/trash" => Some("\\Trash".to_string()),
        "drafts" | "draft" | "draftbox" | "brouillons" | "[gmail]/drafts" => {
            Some("\\Drafts".to_string())
        }
        "junk" | "spam" | "junk e-mail" | "[gmail]/spam" => Some("\\Junk".to_string()),
        "archive" | "archives" | "[gmail]/all mail" => Some("\\Archive".to_string()),
        _ => None,
    }
}

// Nine parameters reflect the IMAP message metadata available at the call site;
// grouping them into a struct would just shuffle the same data. Kept flat for
// readability of the ported logic.
#[allow(clippy::too_many_arguments)]
fn parse_message(
    parser: &MessageParser,
    raw: &[u8],
    uid: u32,
    folder: &str,
    raw_size: u32,
    is_read: bool,
    is_starred: bool,
    is_draft: bool,
    internal_date: Option<i64>,
) -> Result<ImapMessage, String> {
    let message = parser.parse(raw).ok_or("Failed to parse MIME message")?;

    let message_id = message.message_id().map(|s| s.to_string());
    let subject = message.subject().map(|s| s.to_string());
    let date = message
        .date()
        .map(|d| d.to_timestamp())
        .or(internal_date)
        .unwrap_or(0);

    let in_reply_to = match message.in_reply_to() {
        mail_parser::HeaderValue::Text(t) => Some(t.to_string()),
        mail_parser::HeaderValue::TextList(list) => list.first().map(|s| s.to_string()),
        _ => None,
    };

    let references = match message.references() {
        mail_parser::HeaderValue::Text(t) => Some(t.to_string()),
        mail_parser::HeaderValue::TextList(list) => {
            if list.is_empty() {
                None
            } else {
                Some(
                    list.iter()
                        .map(|s| s.as_ref())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            }
        }
        _ => None,
    };

    let (from_address, from_name) = extract_first_address(message.from());
    let to_addresses = format_address_list(message.to());
    let cc_addresses = format_address_list(message.cc());
    let bcc_addresses = format_address_list(message.bcc());
    let reply_to = format_address_list(message.reply_to());

    let body_text = message.body_text(0).map(|s| s.to_string());
    let body_html = message.body_html(0).map(|s| s.to_string());

    let snippet = body_text.as_ref().map(|text| {
        let cleaned: String = text
            .chars()
            .map(|c| if c.is_whitespace() { ' ' } else { c })
            .collect();
        let trimmed = cleaned.trim();
        if trimmed.chars().count() > 200 {
            let end: String = trimmed.chars().take(200).collect();
            format!("{end}...")
        } else {
            trimmed.to_string()
        }
    });

    let list_unsubscribe =
        extract_header_text(message.header(mail_parser::HeaderName::ListUnsubscribe));
    let list_unsubscribe_post = extract_header_text(message.header(
        mail_parser::HeaderName::Other("List-Unsubscribe-Post".into()),
    ));
    let auth_results = extract_header_text(message.header(mail_parser::HeaderName::Other(
        "Authentication-Results".into(),
    )));

    let section_map = build_imap_section_map(&message);

    log::debug!(
        "IMAP parse UID {uid}: {} parts, {} attachment indices {:?}, section_map: {:?}",
        message.parts.len(),
        message.attachments.len(),
        message.attachments,
        section_map,
    );

    let attachments: Vec<ImapAttachment> = message
        .attachments
        .iter()
        .filter_map(|&part_idx| {
            let att = message.parts.get(part_idx)?;
            let section = match section_map.get(&part_idx) {
                Some(s) => s.clone(),
                None => {
                    log::warn!(
                        "IMAP UID {uid}: attachment at part index {part_idx} not found in section map (map has {} entries)",
                        section_map.len(),
                    );
                    return None;
                }
            };

            let mime_type = att
                .content_type()
                .map(|ct| {
                    let ctype = ct.ctype();
                    let subtype = ct.subtype().unwrap_or("octet-stream");
                    format!("{ctype}/{subtype}")
                })
                .unwrap_or_else(|| "application/octet-stream".to_string());

            Some(ImapAttachment {
                part_id: section,
                filename: att
                    .attachment_name()
                    .unwrap_or("attachment")
                    .to_string(),
                mime_type,
                size: att.len() as u32,
                content_id: att.content_id().map(|s| s.to_string()),
                is_inline: att.content_disposition().is_some_and(|cd| cd.is_inline()),
            })
        })
        .collect();

    Ok(ImapMessage {
        uid,
        folder: folder.to_string(),
        message_id,
        in_reply_to,
        references,
        from_address,
        from_name,
        to_addresses,
        cc_addresses,
        bcc_addresses,
        reply_to,
        subject,
        date,
        is_read,
        is_starred,
        is_draft,
        body_html,
        body_text,
        snippet,
        raw_size,
        list_unsubscribe,
        list_unsubscribe_post,
        auth_results,
        attachments,
    })
}

fn build_imap_section_map(
    message: &mail_parser::Message,
) -> std::collections::HashMap<usize, String> {
    use mail_parser::PartType;

    let mut map = std::collections::HashMap::new();

    fn walk(
        parts: &[mail_parser::MessagePart],
        part_idx: usize,
        prefix: &str,
        map: &mut std::collections::HashMap<usize, String>,
    ) {
        if let Some(part) = parts.get(part_idx) {
            if let PartType::Multipart(children) = &part.body {
                for (i, &child_idx) in children.iter().enumerate() {
                    let section = if prefix.is_empty() {
                        format!("{}", i + 1)
                    } else {
                        format!("{}.{}", prefix, i + 1)
                    };
                    walk(parts, child_idx, &section, map);
                }
            } else {
                let section = if prefix.is_empty() {
                    "1".to_string()
                } else {
                    prefix.to_string()
                };
                map.insert(part_idx, section);
            }
        }
    }

    if !message.parts.is_empty() {
        walk(&message.parts, 0, "", &mut map);
    }

    map
}

fn extract_header_text(hv: Option<&mail_parser::HeaderValue>) -> Option<String> {
    match hv {
        Some(mail_parser::HeaderValue::Text(t)) => Some(t.to_string()),
        Some(mail_parser::HeaderValue::TextList(list)) => Some(
            list.iter()
                .map(|s| s.as_ref())
                .collect::<Vec<_>>()
                .join(", "),
        ),
        _ => None,
    }
}

fn extract_first_address(addr: Option<&mail_parser::Address>) -> (Option<String>, Option<String>) {
    let addr = match addr {
        Some(a) => a,
        None => return (None, None),
    };

    if let Some(first) = addr.first() {
        let email = first.address.as_ref().map(|s| s.to_string());
        let name = first.name.as_ref().map(|s| s.to_string());
        (email, name)
    } else {
        (None, None)
    }
}

fn format_address_list(addr: Option<&mail_parser::Address>) -> Option<String> {
    let addr = addr?;

    let parts: Vec<String> = addr
        .iter()
        .map(|a| {
            let email = a.address.as_deref().unwrap_or("");
            match a.name.as_deref() {
                Some(name) if !name.is_empty() => format!("{name} <{email}>"),
                _ => email.to_string(),
            }
        })
        .collect();

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

/// Map a set of IMAP capability strings to the feature flags the sync engine cares
/// about. Pure so it's unit-testable; `session_capabilities` runs the live command
/// then delegates here.
pub fn capabilities_from_strs<'a, I: IntoIterator<Item = &'a str>>(
    caps: I,
) -> (bool, bool, bool, bool) {
    let mut idle = false;
    let mut condstore = false;
    let mut qresync = false;
    let mut vanished = false;
    for c in caps {
        let up = c.to_ascii_uppercase();
        match up.as_str() {
            "IDLE" => idle = true,
            "CONDSTORE" => condstore = true,
            "QRESYNC" => qresync = true,
            "VANISHED" => vanished = true,
            _ => {}
        }
    }
    (idle, condstore, qresync, vanished)
}

/// Run CAPABILITY on an open session and map to the feature tuple
/// `(idle, condstore, qresync, vanished)`. Uses `has_str` for case-insensitive
/// matching (async-imap's `Capability` enum has no public `as_str`, so we cannot
/// route the live `HashSet` through `capabilities_from_strs` directly).
pub async fn session_capabilities(
    session: &mut ImapSession,
) -> Result<(bool, bool, bool, bool), String> {
    let caps = session.capabilities().await.map_err(|e| e.to_string())?;
    Ok((
        caps.has_str("IDLE"),
        caps.has_str("CONDSTORE"),
        caps.has_str("QRESYNC"),
        caps.has_str("VANISHED"),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        capabilities_from_strs, fetch_changed_flags_response_from_fetches, uid_set_raw,
        SYNC_FETCH_QUERY,
    };

    /// RED test 1 for the CONDSTORE CHANGEDSINCE flag-change parser. Maps three
    /// parsed Fetch responses (uid, flags, modseq) into `ImapFlagChange`s and
    /// computes the next modseq cursor = max(max_fetch_modseq, mailbox_highest).
    /// The live `uid_fetch` is exercised in the Task 5 manual e2e; here we test
    /// the pure reduction so the parsing/mapping logic is covered without a socket.
    #[test]
    fn changed_flags_parser_maps_modseq_and_flags() {
        // Simulate three parsed Fetches from a CHANGEDSINCE response.
        let out = fetch_changed_flags_response_from_fetches(
            100, // since_modseq
            vec![
                (10, vec!["\\Seen".to_string()], 150u64),            // uid 10 now read, modseq 150
                (11, vec!["\\Flagged".to_string()], 160),            // uid 11 now starred
                (12, vec!["\\Seen".to_string(), "\\Flagged".to_string()], 170),  // both
            ],
            175, // mailbox HIGHESTMODSEQ
        );
        assert_eq!(out.0.len(), 3);
        assert!(out.0.iter().any(|c| c.uid == 10 && c.is_read && !c.is_starred));
        assert!(out.0.iter().any(|c| c.uid == 11 && !c.is_read && c.is_starred));
        assert!(out.0.iter().any(|c| c.uid == 12 && c.is_read && c.is_starred));
        // next_modseq = max(fetch modseq, mailbox highestmodseq) = 175
        assert_eq!(out.1, 175);
    }

    /// RED test 2 for the parser: an empty change set still advances the cursor to
    /// `max(since, mailbox_highest)`. A no-change round must not stall the modseq
    /// cursor at the stale `since` value forever (otherwise every subsequent round
    /// re-queries the same window and we lose liveness).
    #[test]
    fn changed_flags_parser_floors_next_modseq_at_since() {
        let out = fetch_changed_flags_response_from_fetches(200, vec![], 200);
        assert!(out.0.is_empty());
        assert_eq!(out.1, 200);
    }

    /// Regression lock for the headers-first sync fix. The folder sweep MUST NOT
    /// request `BODY.PEEK[]` (full body) — that hangs async-imap on large folders
    /// and downloads gigabytes of bodies the user may never open. Sync pulls
    /// headers + metadata only; bodies arrive on demand via `sync_request_bodies`
    /// → `fetch_message_body`. If this assertion fails, someone reverted the
    /// sync query to the full-body form.
    #[test]
    fn sync_fetch_query_is_headers_only_not_full_body() {
        assert!(
            SYNC_FETCH_QUERY.contains("HEADER.FIELDS"),
            "SYNC_FETCH_QUERY must select header fields (BODY.PEEK[HEADER.FIELDS ...]); \
             got: {SYNC_FETCH_QUERY}",
        );
        assert!(
            !SYNC_FETCH_QUERY.contains("BODY.PEEK[]"),
            "SYNC_FETCH_QUERY must NOT contain the full-body literal `BODY.PEEK[]` \
             (it hangs large-folder sync); got: {SYNC_FETCH_QUERY}",
        );
        // The query must also request the metadata the message list / threading
        // needs — FLAGS, INTERNALDATE, UID, and RFC822.SIZE (the last so the UI
        // can show message sizes without a second fetch).
        assert!(SYNC_FETCH_QUERY.contains("UID"));
        assert!(SYNC_FETCH_QUERY.contains("FLAGS"));
        assert!(SYNC_FETCH_QUERY.contains("INTERNALDATE"));
        assert!(SYNC_FETCH_QUERY.contains("RFC822.SIZE"));
    }

    #[test]
    fn capabilities_from_strs_maps_known_flags() {
        let (idle, condstore, qresync, vanished) =
            capabilities_from_strs(["IMAP4rev1", "IDLE", "CONDSTORE", "QRESYNC", "VANISHED"]);
        assert!(idle, "IDLE should map to idle");
        assert!(condstore, "CONDSTORE should map to condstore");
        assert!(qresync, "QRESYNC should map to qresync");
        assert!(vanished, "VANISHED should map to vanished");
    }

    #[test]
    fn capabilities_from_strs_case_insensitive() {
        let (idle, _, _, _) = capabilities_from_strs(["idle"]);
        assert!(idle, "mapping should be case-insensitive");
        let (_, condstore, _, _) = capabilities_from_strs(["condstore"]);
        assert!(condstore);
    }

    #[test]
    fn capabilities_from_strs_empty_when_no_known_flags() {
        let (idle, condstore, qresync, vanished) =
            capabilities_from_strs(["IMAP4rev1", "STARTTLS", "LOGINDISABLED"]);
        assert!(!idle && !condstore && !qresync && !vanished);
    }

    #[test]
    fn capabilities_from_strs_empty_iter() {
        let (idle, condstore, qresync, vanished) = capabilities_from_strs::<[&str; 0]>([]);
        assert!(!idle && !condstore && !qresync && !vanished);
    }

    /// Regression lock for the single-connection raw fetch path
    /// (`raw_fetch_folder`). The per-chunk UID command MUST be a comma-joined
    /// list with no trailing separator — a malformed set (`1,2,3,`) makes the
    /// server reject the FETCH and we lose the whole chunk. This is the one
    /// pure piece of the bulk-fetch path; the socket/login/SELECT logic is
    /// exercised in the manual e2e (large folder finishes instead of BYE-looping).
    #[test]
    fn uid_set_raw_joins_comma_no_trailing_separator() {
        assert_eq!(uid_set_raw(&[]), "");
        assert_eq!(uid_set_raw(&[42]), "42");
        assert_eq!(uid_set_raw(&[1, 2, 3]), "1,2,3");
        assert_eq!(uid_set_raw(&[100, 200, 300, 400]), "100,200,300,400");
        // No trailing comma on any length.
        let s = uid_set_raw(&[7, 8, 9, 10, 11]);
        assert!(!s.ends_with(','), "uid_set_raw must not trail with a comma: {s}");
    }
}
