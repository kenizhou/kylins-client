// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

use async_imap::{types::Flag, Authenticator, Client, Session};
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
/// on-wire size without a second round-trip. `CONTENT-TYPE` is included so the
/// Phase 1b S/MIME receive-detection path can derive `crypto_kind` from the
/// top-level Content-Type + `smime-type` parameter at zero extra round-trips.
pub const SYNC_FETCH_QUERY: &str =
    "UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO CC BCC REPLY-TO \
     DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST \
     AUTHENTICATION-RESULTS CONTENT-TYPE)]";

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
    let mut session = tokio::time::timeout(OVERALL_CONNECT_TIMEOUT, connect_inner(config))
        .await
        .map_err(|_| format!(
            "IMAP connection to {}:{} timed out after {}s — check your server settings or network connection",
            config.host, config.port, OVERALL_CONNECT_TIMEOUT.as_secs()
        ))??;
    log_capabilities(&mut session).await;
    Ok(session)
}

/// Diagnostic helper: query and log the full server capability set once,
/// right after a connection is established. Called from both TLS and STARTTLS
/// connect paths so we can verify IDLE/CONDSTORE/etc. on every fresh connection
/// without flooding the log on every subsequent command.
async fn log_capabilities(session: &mut ImapSession) {
    match session.capabilities().await {
        Ok(caps) => {
            let cap_strings: Vec<String> = caps.iter().map(|c| format!("{:?}", c)).collect();
            log::info!(
                "[imap] raw capabilities ({}): {}",
                cap_strings.len(),
                cap_strings.join(" ")
            );
        }
        Err(e) => {
            log::warn!("[imap] capability query after connect failed: {e}");
        }
    }
}

async fn connect_inner(config: &ImapConfig) -> Result<ImapSession, String> {
    if config.security == "starttls" {
        let session = connect_starttls(config).await?;
        return Ok(session);
    }
    let stream = connect_stream(config).await?;
    let client = Client::new(stream);
    let session = tokio::time::timeout(AUTH_TIMEOUT, authenticate(client, config))
        .await
        .map_err(|_| format!(
            "IMAP authentication timed out after {}s — check your server settings or network connection",
            AUTH_TIMEOUT.as_secs()
        ))??;
    Ok(session)
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

/// `SYNC_FETCH_QUERY` wrapped in the outer `()` that RFC 3501 requires for a
/// multi-item fetch-att list. Kept as a small helper so `fetch_messages` and the
/// regression test share the exact same wrapping logic.
pub fn sync_fetch_query_wrapped() -> String {
    format!("({SYNC_FETCH_QUERY})")
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

    let query = sync_fetch_query_wrapped();
    let fetches = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
        let stream = session
            .uid_fetch(uid_range, &query)
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
        let raw = match fetch.header() {
            Some(b) => b,
            None => {
                log::warn!("IMAP FETCH {folder}: UID {uid} has no header");
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

/// Multi-item FETCH query used by `fetch_message_body`. Wrapped in `()` per RFC 3501.
pub(crate) fn message_body_fetch_query() -> &'static str {
    "(UID FLAGS BODY.PEEK[])"
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
            .uid_fetch(&uid_str, message_body_fetch_query())
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

/// Typed body prefetch against an already-SELECTed `Session`. Used by
/// `ImapSessionManager::execute` so on-demand body batches reuse the persistent
/// IMAP session instead of opening a fresh raw connection (and fresh LOGIN) per
/// batch. `BODY.PEEK[]` keeps the message unread; `(UID BODY.PEEK[])` ensures the
/// response includes the UID so we can match it back to the caller's uid list.
pub async fn fetch_bodies_batch_on_session(
    session: &mut ImapSession,
    folder: &str,
    uids: &[u32],
    chunk_size: usize,
) -> Result<Vec<FetchedBody>, String> {
    if uids.is_empty() {
        return Ok(vec![]);
    }
    let chunk_size = if chunk_size == 0 { 50 } else { chunk_size };

    log::info!(
        "FETCH BODIES BATCH (managed): {folder}, {} UID(s) in chunks of {chunk_size}",
        uids.len()
    );

    let parser = MessageParser::default();
    let mut out: Vec<FetchedBody> = Vec::new();
    let chunks: Vec<&[u32]> = uids.chunks(chunk_size).collect();

    for chunk in &chunks {
        let range = uid_set_raw(chunk);
        let fetch_result = tokio::time::timeout(IMAP_FETCH_TIMEOUT, async {
            let stream = session
                .uid_fetch(&range, "(UID BODY.PEEK[])")
                .await
                .map_err(|e| format!("UID FETCH {folder} uids={range} failed: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        })
        .await
        .map_err(|_| {
            format!(
                "UID FETCH {folder} timed out after {}s",
                IMAP_FETCH_TIMEOUT.as_secs()
            )
        });

        let fetches: Vec<_> = match fetch_result {
            Ok(Ok(rows)) => rows.into_iter().filter_map(|r| r.ok()).collect(),
            Ok(Err(e)) | Err(e) => {
                log::warn!(
                    "fetch_bodies_batch_on_session {folder}: chunk {range} failed ({e}); \
                     returning {} of {} UID(s) already fetched",
                    out.len(),
                    uids.len()
                );
                break;
            }
        };

        for fetch in fetches {
            let uid = match fetch.uid {
                Some(u) => u,
                None => {
                    log::warn!("fetch_bodies_batch_on_session {folder}: FETCH response missing UID; skipping");
                    continue;
                }
            };
            let raw = match fetch.body() {
                Some(b) => b,
                None => {
                    log::warn!("fetch_bodies_batch_on_session {folder}: UID {uid} has no body; skipping");
                    continue;
                }
            };
            let parsed = match parser.parse(raw) {
                Some(m) => m,
                None => {
                    log::warn!(
                        "fetch_bodies_batch_on_session {folder}: UID {uid} parse failed; skipping"
                    );
                    continue;
                }
            };
            let body_text = parsed.body_text(0).map(|s| s.to_string());
            let body_html = parsed.body_html(0).map(|s| s.to_string());
            let snippet = derive_snippet(body_text.as_deref().unwrap_or(""));
            let attachments = extract_attachments(&parsed, uid);
            out.push(FetchedBody {
                uid,
                body_html,
                body_text,
                snippet,
                attachments,
            });
        }
    }

    log::info!(
        "FETCH BODIES BATCH (managed) {folder}: {}/{} UID(s) fetched",
        out.len(),
        uids.len()
    );
    Ok(out)
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

/// Multi-item FETCH query used by `fetch_changed_flags`. The fetch-att list is
/// wrapped in `()` per RFC 3501; the `CHANGEDSINCE` modifier is a separate
/// parenthetical per RFC 7162 §3.1. Nesting `CHANGEDSINCE` inside the fetch-att
/// list is a protocol error that strict servers (Yahoo) reject.
pub(crate) fn changed_flags_fetch_query(since_modseq: u64) -> String {
    format!("(UID FLAGS MODSEQ) (CHANGEDSINCE {since_modseq})")
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
    let query = changed_flags_fetch_query(since_modseq);
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

/// Multi-item FETCH query used by the legacy `sync_folder` full-body prefetch path.
/// Wrapped in `()` per RFC 3501.
pub(crate) fn prefetch_bodies_fetch_query() -> &'static str {
    "(UID FLAGS INTERNALDATE BODY.PEEK[])"
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
                .uid_fetch(&uid_set, prefetch_bodies_fetch_query())
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

        // Protocol trace: the UID FETCH command (without the parenthesized list
        // body, which is long and constant — see SYNC_FETCH_QUERY). Logged at
        // DEBUG so it ships in dev builds but not release.
        log::debug!("C: {tag} UID FETCH {range} (SYNC_FETCH_QUERY)");

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
                log::debug!(
                    "S: {tag} OK (FETCH FOLDER chunk {} uids {range}: {} message(s))",
                    i + 1,
                    raw_messages.len()
                );
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
                log::debug!("S: {tag} <error: {e}> (FETCH FOLDER chunk {})", i + 1);
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

/// Derive a single-line preview from a body's plain-text part: collapse all
/// whitespace runs to one space, trim, cap at 200 chars. Pure so it can be
/// unit-tested without a socket.
///
/// Note: the cap is 200 `char`s (Unicode scalar values), not bytes — a 200-char
/// cap on a multibyte body would otherwise truncate mid-codepoint. Truncation is
/// hard (no trailing `...`) so the caller can compose; the thread-list UI owns
/// ellipsization, not the parser.
fn derive_snippet(body_text: &str) -> String {
    let collapsed: String = body_text
        .split(|c: char| c.is_whitespace())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    collapsed.chars().take(200).collect()
}

/// Build the `a1 LOGIN` / `a1 AUTHENTICATE XOAUTH2` command for `config`. Used
/// by the raw-fetch paths so they share one auth-string construction.
fn build_login_cmd(config: &ImapConfig) -> String {
    if config.auth_method == "oauth2" {
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
    }
}

/// Open a raw IMAP connection, LOGIN, SELECT `folder`, then `UID FETCH <uid>
/// (UID BODY.PEEK[])` and parse the single returned message with mail_parser.
/// Used by `fetch_inline_cid_parts` (the `sync_fetch_inline_images` command) to
/// obtain the parsed MIME tree so all CID-tagged inline parts can be located
/// and extracted in one pass. `fetch_attachment_bytes` no longer uses this
/// path — it now uses `fetch_part_bytes_inner` (BODY.PEEK[<part>] partial fetch)
/// instead of downloading the full message just to extract one part. Single
/// connection lifecycle (connect → login → select → fetch → drop), like
/// `fetch_bodies_batch`. Raw (NOT async-imap) because async-imap returns 0
/// items on this server. Returns `Ok(None)` if the server sent no FETCH
/// response for the UID.
async fn fetch_parsed_message(
    config: &ImapConfig,
    folder: &str,
    uid: u32,
) -> Result<Option<mail_parser::Message<'static>>, String> {
    log::info!(
        "FETCH PARSED: {}:{} {folder} UID {uid}",
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
    raw_send_and_wait(&mut reader, build_login_cmd(config).as_bytes(), "a1").await?;
    let _ = raw_send_and_wait(
        &mut reader,
        format!("a2 SELECT \"{folder}\"\r\n").as_bytes(),
        "a2",
    )
    .await?;
    // (UID BODY.PEEK[]) — UID must be requested explicitly (RFC 3501) so the
    // response carries `UID <u>` (see commit a4d50f4). BODY.PEEK so opening /
    // extracting a part does not mark the message \Seen.
    let fetch_cmd = format!("a3 UID FETCH {uid} (UID BODY.PEEK[])\r\n");
    log::debug!("C: a3 UID FETCH {uid} (UID BODY.PEEK[])");
    reader
        .get_mut()
        .write_all(fetch_cmd.as_bytes())
        .await
        .map_err(|e| format!("write fetch cmd: {e}"))?;
    let raws = raw_parse_fetch_responses(&mut reader, "a3").await?;
    let raw = match raws.into_iter().next() {
        Some(r) => r,
        None => return Ok(None),
    };
    // parse() borrows from raw.body (a local); into_owned() detaches the
    // message into Message<'static> so it can be returned.
    Ok(MessageParser::default().parse(&raw.body).map(|m| m.into_owned()))
}

/// Fetch ONE attachment part by IMAP MIME section (`part_id`, e.g. "1.2") and
/// return its decoded bytes + mime type. Uses `BODY.PEEK[<part_id>.MIME]` (part
/// headers) + `BODY.PEEK[<part_id>]` (transfer-encoded body) — partial fetch —
/// instead of `BODY.PEEK[]` (full message). A 50KB attachment in a 20MB message
/// downloads just the part bytes (50KB + a tiny header literal), not the full
/// 20MB. Thunderbird's approach.
///
/// Two FETCHes on one raw connection (each goes through `raw_parse_fetch_responses`):
///
/// 1. `a3 UID FETCH {uid} (UID BODY.PEEK[{part_id}.MIME])` — small literal
///    containing Content-Type, Content-Transfer-Encoding, Content-Disposition,
///    Content-ID. Per RFC 3501 §6.4.5 the `.MIME` suffix returns the MIME
///    headers of the part followed by a blank line.
/// 2. `a4 UID FETCH {uid} (UID BODY.PEEK[{part_id}])` — the transfer-encoded
///    body bytes of the leaf part.
///
/// `decode_part_bytes` (pure helper, unit-tested) then concatenates the two
/// into a single-part RFC5322 wrapper and lets mail_parser handle the
/// transfer-encoding decode (base64 / quoted-printable / 7bit / 8bit / binary).
///
/// Both fetches are PEEK so the message is NOT marked \Seen. The cache miss-path
/// (`attachment_cache::get_or_fetch` → `sync_engine::commands::fetch_attachment`)
/// calls this function; its interface is unchanged from the previous full-message
/// implementation.
pub async fn fetch_attachment_bytes(
    config: &ImapConfig,
    folder: &str,
    uid: u32,
    part_id: &str,
) -> Result<(String, Vec<u8>), String> {
    match fetch_part_bytes_inner(config, folder, uid, part_id).await? {
        Some(result) => Ok(result),
        None => Err(format!(
            "UID {uid} part {part_id} in {folder}: server returned no FETCH response \
             (message deleted, UID not in folder, or part_id wrong)"
        )),
    }
}

/// Raw-connection core for [`fetch_attachment_bytes`]. Returns
/// `Ok(Some((mime_type, decoded_bytes)))` on success, `Ok(None)` if the server
/// sent no FETCH response for the UID (so the caller can produce a precise
/// error message). Factored as a separate fn so the Option/Err distinction is
/// explicit and the public API stays simple.
///
/// `part_id` validation is here, not in the public wrapper, so internal callers
/// (when/if any) also get the guard. The check rejects anything that isn't a
/// dotted numeric path — guards against command injection since `part_id` is
/// interpolated raw into the FETCH command string (no quoting in IMAP section
/// syntax to lean on).
async fn fetch_part_bytes_inner(
    config: &ImapConfig,
    folder: &str,
    uid: u32,
    part_id: &str,
) -> Result<Option<(String, Vec<u8>)>, String> {
    log::info!(
        "FETCH PART: {}:{} {folder} UID {uid} part {part_id}",
        config.host,
        config.port
    );

    // part_id is a dotted numeric path like "1", "2", "1.2", "2.1.3". We send
    // it raw inside an IMAP FETCH command, so guard against anything that could
    // break out of the BODY[...] brackets (newline, space, ']', etc.) — even
    // though a well-behaved caller passes a server-returned section string,
    // defense in depth is cheap here.
    if part_id.is_empty()
        || part_id
            .chars()
            .any(|c| !c.is_ascii_digit() && c != '.')
    {
        return Err(format!(
            "Invalid IMAP part_id {part_id:?}: must be a non-empty dotted numeric path \
             (e.g. \"1\", \"1.2\", \"2.1.3\")"
        ));
    }

    // 1. connect + greeting + login + SELECT — same pattern as
    //    `fetch_parsed_message`. Single connection lifecycle for both FETCHes.
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
    raw_send_and_wait(&mut reader, build_login_cmd(config).as_bytes(), "a1").await?;
    let _ = raw_send_and_wait(
        &mut reader,
        format!("a2 SELECT \"{folder}\"\r\n").as_bytes(),
        "a2",
    )
    .await?;

    // 2. FETCH the part's MIME headers. `.MIME` per RFC 3501 §6.4.5 returns
    //    the MIME headers of the named part followed by a blank line — i.e.
    //    Content-Type, Content-Transfer-Encoding, Content-Disposition,
    //    Content-ID. This literal is small (typically <1KB) and is what lets
    //    us decode the body literal in the second fetch.
    let mime_cmd = format!("a3 UID FETCH {uid} (UID BODY.PEEK[{part_id}.MIME])\r\n");
    log::debug!("C: a3 UID FETCH {uid} (UID BODY.PEEK[{part_id}.MIME])");
    reader
        .get_mut()
        .write_all(mime_cmd.as_bytes())
        .await
        .map_err(|e| format!("write .MIME fetch: {e}"))?;
    let mime_raws = raw_parse_fetch_responses(&mut reader, "a3").await?;
    let mime_headers = match mime_raws.into_iter().next() {
        Some(r) => r.body,
        None => return Ok(None),
    };

    // 3. FETCH the part body. `BODY.PEEK[<part>]` (no suffix) on a leaf part
    //    returns the transfer-encoded body bytes (base64 / QP / etc. as they
    //    appear on the wire). For a multipart section this would return the
    //    rendered multipart body, but `part_id` is always a leaf for
    //    attachments — the section comes from `extract_attachments` which only
    //    emits leaf part indices.
    let body_cmd = format!("a4 UID FETCH {uid} (UID BODY.PEEK[{part_id}])\r\n");
    log::debug!("C: a4 UID FETCH {uid} (UID BODY.PEEK[{part_id}])");
    reader
        .get_mut()
        .write_all(body_cmd.as_bytes())
        .await
        .map_err(|e| format!("write body fetch: {e}"))?;
    let body_raws = raw_parse_fetch_responses(&mut reader, "a4").await?;
    let encoded_body = match body_raws.into_iter().next() {
        Some(r) => r.body,
        None => return Ok(None),
    };

    // 4. best-effort LOGOUT (ignore errors — connection may already be closed
    //    by the server after the tagged OK).
    let _ = reader.get_mut().write_all(b"a5 LOGOUT\r\n").await;

    // 5. Pure decode: combine headers + blank-line separator + encoded body
    //    into a single-part RFC5322 wrapper, let mail_parser decode the
    //    transfer encoding.
    let (mime_type, data) = decode_part_bytes(&mime_headers, &encoded_body)?;
    Ok(Some((mime_type, data)))
}

/// Pure helper: given the raw bytes of a MIME part's headers (the
/// `BODY.PEEK[<part>.MIME]` literal) and its transfer-encoded body bytes
/// (the `BODY.PEEK[<part>]` literal), decode the body according to its
/// Content-Transfer-Encoding and return `(mime_type, decoded_bytes)`.
///
/// Wraps the two literals into a single-part RFC5322 message and lets
/// `mail_parser` handle the transfer-encoding decode (base64, quoted-printable,
/// 7bit, 8bit, binary — all per RFC 2045). The `.MIME` literal from a compliant
/// IMAP server already ends with the blank-line separator (`\r\n\r\n`); we add
/// it defensively if a server trims it, so mail_parser sees a proper
/// header/body boundary.
///
/// Pure (no I/O) so the decode logic is unit-testable without a socket — see
/// the `tests::decode_part_bytes_*` cases below for base64 / quoted-printable /
/// 7bit / binary / missing-separator coverage.
fn decode_part_bytes(
    mime_headers: &[u8],
    encoded_body: &[u8],
) -> Result<(String, Vec<u8>), String> {
    let mut wrapped = Vec::with_capacity(mime_headers.len() + 4 + encoded_body.len());
    wrapped.extend_from_slice(mime_headers);
    // The .MIME literal from a compliant IMAP server already ends with the
    // blank-line separator (`\r\n\r\n`). Be defensive: if it's missing
    // (e.g. a server that strips trailing CRLF), append it so mail_parser
    // sees a proper header/body boundary. Without this, the first body line
    // would be parsed as a header and the body would come back empty/garbled.
    if !ends_with_crlf_crlf(&wrapped) {
        wrapped.extend_from_slice(b"\r\n\r\n");
    }
    wrapped.extend_from_slice(encoded_body);

    let parser = MessageParser::default();
    let message = parser
        .parse(&wrapped)
        .ok_or("Failed to parse wrapped MIME part (mail_parser returned None)")?;

    let part = message
        .parts
        .first()
        .ok_or("Wrapped MIME part has no root part")?;

    let mime_type = part
        .content_type()
        .map(|ct| {
            let ctype = ct.ctype();
            let subtype = ct.subtype().unwrap_or("octet-stream");
            format!("{ctype}/{subtype}")
        })
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let data = match &part.body {
        mail_parser::PartType::Binary(d) | mail_parser::PartType::InlineBinary(d) => {
            d.as_ref().to_vec()
        }
        mail_parser::PartType::Text(t) => t.as_bytes().to_vec(),
        mail_parser::PartType::Html(h) => h.as_bytes().to_vec(),
        mail_parser::PartType::Message(m) => m.raw_message.as_ref().to_vec(),
        mail_parser::PartType::Multipart(_) => {
            return Err(
                "Wrapped MIME part parsed as multipart — expected a leaf part \
                 (headers + body). The server may have returned a multipart \
                 container section; caller should pass a leaf part_id."
                    .to_string(),
            );
        }
    };
    Ok((mime_type, data))
}

/// Pure helper: true if `b` ends with `\r\n\r\n` (the MIME header/body blank
/// separator). Used by `decode_part_bytes` to decide whether to insert a separator.
fn ends_with_crlf_crlf(b: &[u8]) -> bool {
    b.len() >= 4 && &b[b.len() - 4..] == b"\r\n\r\n"
}

/// Fetch all inline parts that carry a `Content-ID` (the parts referenced by
/// `cid:` in an HTML body) for a message in ONE round-trip — returns each as
/// `(content_id, mime_type, decoded-bytes)`. Used by `sync_fetch_inline_images`
/// so the reading pane can cache inline images as files + render via
/// `convertFileSrc` without N full-message fetches. Fetches the full message
/// once via `fetch_parsed_message` and walks the parsed MIME tree. Best-effort:
/// parts that fail to extract are skipped. Returns the **decoded** bytes
/// (mail_parser handles base64/quoted-printable); the caller writes them to a
/// cache file — no base64 crosses IPC.
pub async fn fetch_inline_cid_parts(
    config: &ImapConfig,
    folder: &str,
    uid: u32,
) -> Result<Vec<InlineCidPart>, String> {
    let message = fetch_parsed_message(config, folder, uid)
        .await?
        .ok_or_else(|| format!("UID {uid} in {folder}: no parseable message"))?;
    let section_map = build_imap_section_map(&message);
    let mut out = Vec::new();
    for &part_idx in section_map.keys() {
        let part = match message.parts.get(part_idx) {
            Some(p) => p,
            None => continue,
        };
        let content_id = match part.content_id() {
            Some(s) => s.trim_matches(['<', '>']).to_string(),
            None => continue,
        };
        let mime_type = part
            .content_type()
            .map(|ct| {
                let ctype = ct.ctype();
                let subtype = ct.subtype().unwrap_or("octet-stream");
                format!("{ctype}/{subtype}")
            })
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let data = match &part.body {
            mail_parser::PartType::Binary(d) | mail_parser::PartType::InlineBinary(d) => {
                d.as_ref().to_vec()
            }
            mail_parser::PartType::Text(t) => t.as_bytes().to_vec(),
            mail_parser::PartType::Html(h) => h.as_bytes().to_vec(),
            mail_parser::PartType::Message(m) => m.raw_message.as_ref().to_vec(),
            mail_parser::PartType::Multipart(_) => continue,
        };
        out.push(InlineCidPart {
            content_id,
            mime_type,
            bytes: data,
        });
    }
    Ok(out)
}

/// One inline `cid:` part returned by [`fetch_inline_cid_parts`]. Internal type
/// (not serialized over IPC) — the caller (`sync_fetch_inline_images_inner`)
/// writes `bytes` to a cache file and returns a [`CachedInlineImage`] (file
/// path) to the frontend.
#[derive(Debug, Clone)]
pub struct InlineCidPart {
    pub content_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
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
    let resp_bytes = &tmp[..n];
    let resp = String::from_utf8_lossy(resp_bytes);
    if !resp.contains("OK") {
        return Err(format!("STARTTLS rejected: {resp}"));
    }
    // RFC 3501 §6.2.1 injection guard — see `connect_starttls` for the full
    // rationale. Same protection on the raw path used by `raw_fetch_folder` /
    // `raw_fetch_messages` / `raw_fetch_diagnostic`: any bytes after the single
    // STARTTLS OK line are an injection and must abort the handshake.
    if let Some(injected) = extract_starttls_injection(resp_bytes) {
        return Err(format!(
            "STARTTLS plaintext injection detected (RFC 3501 §6.2.1): trailing {injected:?} after OK; aborting handshake"
        ));
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
    // Protocol trace: log the command being sent (C: ...) at DEBUG. Trim the
    // trailing CRLF + mask the password in LOGIN/AUTHENTICATE so the trace is
    // safe to ship in a log file. The raw bytes here are exactly what goes on
    // the wire (tag + command + CRLF), matching the IMAP convention of logging
    // "C: <command>" / "S: <response>".
    let cmd_str = String::from_utf8_lossy(cmd);
    let cmd_trimmed = cmd_str.trim_end_matches(['\r', '\n']);
    let masked = if cmd_trimmed.starts_with("a1 LOGIN")
        || cmd_trimmed.starts_with("a1 AUTHENTICATE")
    {
        // Mask credentials: keep the command verb + tag, drop the payload.
        if let Some(space_idx) = cmd_trimmed.find(' ') {
            // "a1 LOGIN ..." -> "a1 LOGIN <masked>"
            let verb_end = cmd_trimmed[space_idx + 1..]
                .find(' ')
                .map(|i| space_idx + 1 + i)
                .unwrap_or(cmd_trimmed.len());
            format!("{} <masked>", &cmd_trimmed[..verb_end])
        } else {
            "<masked>".to_string()
        }
    } else {
        cmd_trimmed.to_string()
    };
    log::debug!("C: {masked}");

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
            Ok(Ok(0)) => {
                log::debug!("S: <connection closed> (tag={tag})");
                return Err(format!("{tag}: connection closed"));
            }
            Ok(Ok(_)) => {
                response.push_str(&line);
                if line.starts_with(&tag_ok) {
                    // Log the tagged OK status line (the final response). Trimming
                    // the CRLF keeps the trace one-line-per-command.
                    log::debug!("S: {}", line.trim_end_matches(['\r', '\n']));
                    return Ok(response);
                }
                if line.starts_with(&tag_no) || line.starts_with(&tag_bad) {
                    log::debug!("S: {}", line.trim_end_matches(['\r', '\n']));
                    return Err(format!("{tag} failed: {line}"));
                }
            }
            Ok(Err(e)) => {
                log::debug!("S: <read error: {e}> (tag={tag})");
                return Err(format!("{tag} read: {e}"));
            }
            Err(_) => {
                log::debug!("S: <timeout> (tag={tag})");
                return Err(format!("{tag}: timeout"));
            }
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
    let response_bytes = &buf[..n];
    let response = String::from_utf8_lossy(response_bytes);
    if !response.contains("OK") {
        return Err(format!("STARTTLS rejected: {response}"));
    }
    // RFC 3501 §6.2.1 injection guard: reject ANY bytes after the STARTTLS OK
    // line before the TLS handshake. A MITM could inject untagged responses
    // (e.g. a fake "* OK ..." or "* BAD ...") that would be misinterpreted as
    // part of the encrypted stream once the handshake takes over. A well-formed
    // server sends exactly one OK line and nothing else.
    if let Some(injected) = extract_starttls_injection(response_bytes) {
        return Err(format!(
            "STARTTLS plaintext injection detected (RFC 3501 §6.2.1): trailing {injected:?} after OK; aborting handshake"
        ));
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
    let mut session = tokio::time::timeout(AUTH_TIMEOUT, authenticate(client, config))
        .await
        .map_err(|_| format!(
            "IMAP authentication timed out after {}s — check your server settings or network connection",
            AUTH_TIMEOUT.as_secs()
        ))??;
    log_capabilities(&mut session).await;
    Ok(session)
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

    // Top-level Content-Type + `smime-type` parameter, used by the Phase 1b
    // receive-detection path in sync_engine::imap_source. mail_parser exposes
    // `ctype()` (main type, e.g. "application") + `subtype()` (e.g.
    // "pkcs7-mime") separately; we assemble the full lowercase "type/subtype"
    // string so the pure helper `crypto_kind_from_content_type` can match it
    // without caring about mail_parser's accessor shape. The `smime-type`
    // parameter is carried on `ContentType::attributes` as `Vec<(Cow<str>,
    // Cow<str>)>`.
    let (content_type, smime_type) = match message.content_type() {
        Some(ct) => {
            let full = match ct.subtype() {
                Some(sub) => format!("{}/{}", ct.ctype(), sub).to_lowercase(),
                None => ct.ctype().to_lowercase(),
            };
            let smime = ct
                .attributes
                .iter()
                .flatten()
                .find(|(k, _)| k.eq_ignore_ascii_case("smime-type"))
                .map(|(_, v)| v.to_lowercase());
            (Some(full), smime)
        }
        None => (None, None),
    };

    let attachments = extract_attachments(&message, uid);

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
        content_type,
        smime_type,
    })
}

/// Extract attachment metadata (IMAP MIME section `part_id`, filename,
/// mime_type, size, content_id, is_inline) from a parsed message. Shared by
/// `parse_message` (folder sync) and `fetch_bodies_batch` (on-demand body
/// fetch) so both paths produce identical `ImapAttachment` metadata that can be
/// persisted to the `attachments` table and later used to fetch a single part
/// via `BODY.PEEK[<part_id>]`. `uid` is for log correlation only.
fn extract_attachments(message: &mail_parser::Message, uid: u32) -> Vec<ImapAttachment> {
    let section_map = build_imap_section_map(message);

    log::debug!(
        "IMAP parse UID {uid}: {} parts, {} attachment indices {:?}, section_map: {:?}",
        message.parts.len(),
        message.attachments.len(),
        message.attachments,
        section_map,
    );

    message
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
                // Trim RFC 2392 angle brackets (`<foo@bar>`) so the stored
                // value matches the bare `cid:foo@bar` form used in HTML and
                // by fetch_inline_cid_parts. Without this, AttachmentList's
                // "hide cid:-referenced parts" filter (`inlineCids.has(cid)`)
                // misses and inline images show twice (in-body + as a chip).
                content_id: att
                    .content_id()
                    .map(|s| s.trim_matches(['<', '>']).to_string()),
                is_inline: att
                    .content_disposition()
                    .is_some_and(|cd| cd.is_inline()),
            })
        })
        .collect()
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

/// Pure helper: detect whether the STARTTLS OK response is followed by extra
/// bytes (the injection attack). RFC 3501 §6.2.1: the client MUST reject any
/// data between the STARTTLS OK and the TLS handshake.
///
/// `ok_response` is the bytes read after sending STARTTLS. If the response
/// contains MORE than the single OK line (e.g. an extra untagged response the
/// attacker injected), this returns the injected bytes; the caller aborts.
fn extract_starttls_injection(ok_response: &[u8]) -> Option<String> {
    // A well-formed STARTTLS OK is exactly one line ending in \r\n:
    //   "a001 OK Begin TLS negotiation now\r\n"
    // Any bytes AFTER the first \r\n are injection.
    let crlf = ok_response.windows(2).position(|w| w == b"\r\n")?;
    let after = &ok_response[crlf + 2..];
    if after.is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(after).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capabilities_from_strs, decode_part_bytes, derive_snippet, ends_with_crlf_crlf,
        extract_starttls_injection, fetch_changed_flags_response_from_fetches, uid_set_raw,
        SYNC_FETCH_QUERY,
    };
    use base64::Engine;

    // ---------- derive_snippet (pure preview-text helper for fetch_bodies_batch) ----------
    //
    // The snippet is the ~200-char single-line preview the thread list shows
    // without re-reading the (large) `message_bodies` row. The live batch fetch
    // is exercised by the Task 5 ignored integration test; here we cover the
    // pure parser so whitespace-collapse + truncation are regression-locked
    // without a socket.

    #[test]
    fn derive_snippet_strips_whitespace_and_truncates() {
        // Leading/trailing whitespace + newlines collapse to single spaces;
        // result is capped at 200 chars.
        let body = "  Hello,\n\n   world.   \n\nThis is a long body.   ";
        let s = derive_snippet(body);
        assert!(s.starts_with("Hello,"));
        assert!(!s.contains('\n'));
        assert!(!s.contains("  ")); // no double spaces
    }

    #[test]
    fn derive_snippet_truncates_at_200_chars() {
        let body = "x".repeat(500);
        let s = derive_snippet(&body);
        assert_eq!(s.len(), 200);
    }

    #[test]
    fn derive_snippet_empty_yields_empty() {
        assert_eq!(derive_snippet("   \n\n  "), "");
        assert_eq!(derive_snippet(""), "");
    }

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

    /// RFC 3501 requires a multi-item fetch-att list to be wrapped in parentheses.
    /// Yahoo (and other strict servers) reject the unparenthesized form, causing
    /// async-imap to return 0 items and forcing a raw-TCP fallback LOGIN storm.
    #[test]
    fn sync_fetch_query_wrapped_is_parenthesized() {
        let q = super::sync_fetch_query_wrapped();
        assert!(
            q.starts_with('(') && q.ends_with(')'),
            "multi-item FETCH query must be wrapped in parentheses per RFC 3501; got: {q}"
        );
        assert!(
            q.contains("BODY.PEEK[HEADER.FIELDS"),
            "wrapped query must still be the headers-only sync query; got: {q}"
        );
    }

    /// `fetch_message_body` uses a multi-item FETCH list and must be parenthesized.
    #[test]
    fn message_body_fetch_query_is_parenthesized() {
        let q = super::message_body_fetch_query();
        assert!(
            q.starts_with('(') && q.ends_with(')'),
            "multi-item FETCH query must be wrapped in parentheses per RFC 3501; got: {q}"
        );
        assert!(q.contains("BODY.PEEK[]"), "query must fetch the full body; got: {q}");
    }

    /// `fetch_changed_flags` uses a multi-item FETCH list and must be parenthesized,
    /// with the RFC 7162 `CHANGEDSINCE` modifier in its own parenthetical.
    #[test]
    fn changed_flags_fetch_query_is_parenthesized() {
        let q = super::changed_flags_fetch_query(12345);
        assert_eq!(
            q,
            "(UID FLAGS MODSEQ) (CHANGEDSINCE 12345)",
            "multi-item FETCH query must wrap fetch-atts and put CHANGEDSINCE in a separate parenthetical per RFC 7162; got: {q}"
        );
    }

    /// The legacy prefetch path uses a multi-item FETCH list and must be parenthesized.
    #[test]
    fn prefetch_bodies_fetch_query_is_parenthesized() {
        let q = super::prefetch_bodies_fetch_query();
        assert!(
            q.starts_with('(') && q.ends_with(')'),
            "multi-item FETCH query must be wrapped in parentheses per RFC 3501; got: {q}"
        );
        assert!(q.contains("BODY.PEEK[]"), "query must fetch the full body; got: {q}");
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

    // ---------- STARTTLS injection guard (RFC 3501 §6.2.1) ----------
    //
    // The pure helper `extract_starttls_injection` is the testable surface of
    // the guard. The live socket wiring (aborting the handshake when trailing
    // bytes appear after the STARTTLS OK) is in `connect_starttls` and
    // `raw_connect_starttls`; those paths can't be exercised without a MITM
    // that injects plaintext, so the regression coverage lives here on the
    // pure function that both call sites consult.

    #[test]
    fn starttls_guard_accepts_single_ok_line() {
        assert_eq!(
            extract_starttls_injection(b"a001 OK Begin TLS negotiation now\r\n"),
            None,
            "a single OK line is clean"
        );
    }

    #[test]
    fn starttls_guard_rejects_trailing_injected_bytes() {
        // An attacker prepends a fake "* OK ..." before the TLS handshake.
        let injected = b"a001 OK Begin TLS negotiation now\r\n* BAD evil injected\r\n";
        let extra = extract_starttls_injection(injected);
        assert_eq!(
            extra.as_deref(),
            Some("* BAD evil injected\r\n"),
            "trailing bytes after the STARTTLS OK must be flagged as injection"
        );
    }

    #[test]
    fn starttls_guard_rejects_trailing_partial_line() {
        // Even partial bytes (no terminating \r\n) are injection.
        let extra = extract_starttls_injection(b"a001 OK\r\nevil");
        assert_eq!(extra.as_deref(), Some("evil"));
    }

    #[test]
    fn starttls_guard_returns_none_on_no_crlf() {
        // Malformed response (no CRLF at all) — caller should already have rejected
        // this for not containing "OK", but the helper returns None rather than
        // panic. The caller's "OK" check catches it first.
        assert_eq!(extract_starttls_injection(b"garbage"), None);
    }

    // ---------- decode_part_bytes (pure transfer-encoding decode) ----------
    //
    // `fetch_attachment_bytes` was rewritten in Task C from "fetch full message
    // + parse MIME tree + extract one part" to "BODY.PEEK[<part>] partial
    // fetch" (Thunderbird's approach). The partial-fetch path gets back TWO
    // literals from the IMAP server — the part's MIME headers (Content-Type,
    // Content-Transfer-Encoding, etc.) and the transfer-encoded body bytes —
    // and `decode_part_bytes` is the pure helper that combines + decodes them.
    // The live IMAP round trip can't be unit-tested (needs a socket), so the
    // regression coverage lives here on the pure decoder.
    //
    // Base64 + QP + 7bit + binary are the four Content-Transfer-Encodings the
    // attachment path realistically sees (QP is common for text with non-ASCII,
    // base64 for binary, 7bit/8bit for plain text). mail_parser handles all of
    // them; these tests pin the behaviour so a future mail_parser version that
    // breaks one of these paths doesn't silently regress attachment downloads.

    #[test]
    fn decode_part_bytes_base64_text() {
        // "Hello, world!" base64-encoded; the .MIME literal from a real server
        // ends in the blank-line separator (\r\n\r\n).
        let headers = b"Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n";
        let body = b"SGVsbG8sIHdvcmxkIQ==";
        let (mime, data) = decode_part_bytes(headers, body).expect("base64 decode should succeed");
        assert_eq!(mime, "text/plain");
        assert_eq!(data, b"Hello, world!");
    }

    #[test]
    fn decode_part_bytes_base64_binary_attachment() {
        // Realistic attachment: application/pdf with base64 body that decodes
        // to PDF magic bytes. Confirms the decoder handles non-text payloads.
        let headers = b"Content-Type: application/pdf; name=\"doc.pdf\"\r\n\
                        Content-Transfer-Encoding: base64\r\n\
                        Content-Disposition: attachment; filename=\"doc.pdf\"\r\n\r\n";
        let pdf_bytes = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(pdf_bytes);
        let (mime, data) =
            decode_part_bytes(headers, encoded.as_bytes()).expect("base64 binary decode");
        assert_eq!(mime, "application/pdf");
        assert_eq!(data, pdf_bytes);
    }

    #[test]
    fn decode_part_bytes_quoted_printable_utf8() {
        // "café" in quoted-printable: =C3=A9 is the UTF-8 for é.
        let headers = b"Content-Type: text/plain; charset=utf-8\r\n\
                        Content-Transfer-Encoding: quoted-printable\r\n\r\n";
        let body = b"caf=C3=A9";
        let (mime, data) =
            decode_part_bytes(headers, body).expect("quoted-printable decode should succeed");
        assert_eq!(mime, "text/plain");
        assert_eq!(data, "café".as_bytes());
    }

    #[test]
    fn decode_part_bytes_7bit_passthrough() {
        // 7bit content has no transfer encoding to undo — bytes flow through
        // unchanged. Confirms the decoder doesn't munge plain ASCII.
        let headers = b"Content-Type: text/plain\r\nContent-Transfer-Encoding: 7bit\r\n\r\n";
        let body = b"plain ascii text, no encoding";
        let (mime, data) = decode_part_bytes(headers, body).expect("7bit decode");
        assert_eq!(mime, "text/plain");
        assert_eq!(data, body);
    }

    #[test]
    fn decode_part_bytes_adds_separator_when_missing() {
        // Defensive path: a server that strips the trailing blank-line separator
        // would otherwise cause mail_parser to parse the first body line as a
        // header. decode_part_bytes must insert \r\n\r\n between headers and body.
        // Headers here end with just one \r\n (no blank line).
        let headers = b"Content-Type: text/plain\r\nContent-Transfer-Encoding: base64";
        let body = b"SGk="; // "Hi"
        let (mime, data) = decode_part_bytes(headers, body).expect("separator insertion path");
        assert_eq!(mime, "text/plain");
        assert_eq!(data, b"Hi");
    }

    #[test]
    fn decode_part_bytes_empty_body() {
        // An empty attachment (zero-byte file) is a valid leaf part. The decode
        // should succeed with empty bytes, not error — Phase A's cache layer
        // depends on this to write a 0-byte cache file rather than fail.
        let headers = b"Content-Type: application/octet-stream\r\n\
                        Content-Transfer-Encoding: base64\r\n\r\n";
        let body = b"";
        let (mime, data) = decode_part_bytes(headers, body).expect("empty body decode");
        assert_eq!(mime, "application/octet-stream");
        assert!(data.is_empty(), "empty body should decode to empty bytes");
    }

    #[test]
    fn decode_part_bytes_html_part() {
        // An HTML text part rather than a binary attachment — the body type
        // cycles through mail_parser's PartType::Html arm. Confirms the
        // match-arm mapping is correct for non-text/plain, non-binary parts.
        let headers = b"Content-Type: text/html; charset=utf-8\r\n\
                        Content-Transfer-Encoding: quoted-printable\r\n\r\n";
        // =3D is QP for =, so this is "<html>=</html>"
        let body = b"<html>=3D</html>";
        let (mime, data) = decode_part_bytes(headers, body).expect("html part decode");
        assert_eq!(mime, "text/html");
        assert_eq!(data, b"<html>=</html>");
    }

    #[test]
    fn decode_part_bytes_invalid_base64_returns_error_or_clean_recovery() {
        // Invalid base64 body — mail_parser may either return an error or
        // produce partial/garbled bytes. We don't pin the exact behaviour,
        // but we DO assert the function doesn't panic. Either Err or a
        // best-effort Ok is acceptable; the caller logs and surfaces the
        // failure up to the attachment-cache miss-path.
        let headers = b"Content-Type: application/octet-stream\r\n\
                        Content-Transfer-Encoding: base64\r\n\r\n";
        let body = b"!!!not valid base64!!!";
        let _ = decode_part_bytes(headers, body); // must not panic
    }

    // ---------- ends_with_crlf_crlf ----------

    #[test]
    fn ends_with_crlf_crlf_detects_separator() {
        assert!(ends_with_crlf_crlf(b"\r\n\r\n"));
        assert!(ends_with_crlf_crlf(b"foo\r\n\r\n"));
        assert!(ends_with_crlf_crlf(b"Content-Type: x\r\n\r\n"));
    }

    #[test]
    fn ends_with_crlf_crlf_rejects_short_or_wrong() {
        assert!(!ends_with_crlf_crlf(b""));
        assert!(!ends_with_crlf_crlf(b"\r\n"));
        assert!(!ends_with_crlf_crlf(b"\r\n\r")); // truncated
        assert!(!ends_with_crlf_crlf(b"\n\n")); // LF only, not CRLF
        assert!(!ends_with_crlf_crlf(b"foo")); // no separator at all
    }
}
