# Yahoo IMAP Feature Optimization Plan

> Based on the official Yahoo Sender Hub IMAP documentation:
> https://senders.yahooinc.com/developer/documentation/#imap-features

## Context

Yahoo's IMAP server is one of the most modern in production — it supports CONDSTORE, QRESYNC, MOVE, OBJECTID, UIDONLY, PARTIAL, and a virtual "All Mail" folder. However, Kylins currently treats Yahoo as a generic IMAP server and does not enable most of these Yahoo-specific capabilities.

**Critical issue:** Yahoo defaults to **Limited Mode** with `MESSAGELIMIT=1000` — only 1,000 messages per folder are visible unless `ENABLE UIDONLY` is sent. Kylins does NOT send this command, so large Yahoo folders are silently truncated.

## Yahoo IMAP Capability Response

```
S: * CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=OAUTHBEARER SASL-IR NAMESPACE ENABLE
     OBJECTID CONDSTORE QRESYNC UIDONLY PARTIAL MESSAGELIMIT=1000
```

## Feature Assessment Table

| Feature | RFC | Yahoo Support | Kylins Status | Optimization Opportunity |
|---------|-----|---------------|---------------|--------------------------|
| **CONDSTORE** | 7162 | ✅ Full | ✅ Used | — |
| **QRESYNC** | 7162 | ✅ Full | ✅ Used | — |
| **IDLE** | 2177 | ⚠️ Partial | ✅ Used | See IDLE limitation below |
| **MOVE** | 6851 | ✅ Full | ❌ Not used | Replace COPY+DELETE+EXPUNGE |
| **OBJECTID** | 8474 | ✅ Full | ❌ Not used | Stable IDs, no hash collisions |
| **UIDONLY** | draft | ✅ Full | ❌ Not enabled | **Unlocks full mailbox (>1000)** |
| **PARTIAL** | draft | ✅ Full | ❌ Not used | Efficient UID pagination |
| **UIDPLUS** | 4315 | ✅ COPYUID | ⚠️ Unknown | APPENDUID for Sent folder |
| **ENABLE** | 5161 | ✅ Full | ❌ Not used | Needed for UIDONLY |
| **LIST-STATUS** | 5819 | ✅ Full | ❌ Not used | N→1 round-trip reduction |
| **SPECIAL-USE** | 6154 | ✅ Full | ✅ Used | — |
| **NAMESPACE** | 2342 | ✅ Full | ❌ Possibly unused | — |
| **OAUTHBEARER** | 7628 | ✅ Full | ❌ Not used | Ready for OAuth2 auth path |
| **SASL-IR** | 4959 | ✅ Full | ❌ Not used | Single-round-trip auth |
| **IMAP ID** | 2971 | ✅ Full | ❌ Not used | Telemetry/troubleshooting |
| **All Mail** | custom | ✅ Experimental | ❌ Not used | Full-mailbox sync |
| **X-POP-UIDL** | custom | ✅ | N/A | Migration support |

## Critical Optimizations (Prioritized)

### P0 — Enable UIDONLY Mode (Unlock Full Mailbox)

**Problem:** Yahoo defaults to **Limited Mode** where each folder is capped at `MESSAGELIMIT=1000` messages. Kylins currently does NOT send `ENABLE UIDONLY`, so folders with >1000 messages are silently truncated — users never see older mail.

**Fix:** After authentication, detect Yahoo (via IMAP `ID` command response) and send:
```
C: A001 ENABLE UIDONLY
S: * ENABLED UIDONLY
S: A001 OK ENABLE completed
```

**Implications of UIDONLY mode:**
- Full mailbox access — no 1000-message cap
- All MSN-based commands fail — must use UID-based commands only
- `PARTIAL` extension becomes available for pagination
- MESSAGELIMIT becomes a per-response cap (not total mailbox cap)
- Sequence numbers returned are UIDs (same properties: 1..UIDNext-1)

**Files to change:**
- `kylins.client.backend/src/mail/imap/client.rs` — Send `ENABLE UIDONLY` after connect + CAPABILITY parse
- `kylins.client.backend/src/sync_engine/imap_source.rs` — Ensure all FETCH/SEARCH/STORE use UID commands (they already do for the most part via `uid_fetch`/`uid_search`/`uid_store`)

### P1 — IDLE Limitation: Detect Expunges

**Problem:** Yahoo's IDLE does NOT report message deletes or EXPUNGE:
> "IDLE responses include only new messages and updates. Message deletes or EXPUNGE will not be available."

Kylins' IDLE watcher currently expects IDLE to report `EXPUNGE`/`VANISHED` events. On Yahoo, expunges are silent — deleted messages remain in the local cache until the next poll-driven full sync.

**Fix (option A):** For Yahoo specifically, force a periodic CONDSTORE re-sync after IDLE wake. When IDLE fires (new message or flag change), run a `FETCH CHANGEDSINCE (last_modseq)` to also catch any expunges that happened since.

**Fix (option B):** Monitor the "All Mail" folder via CONDSTORE. "All Mail" publishes deletions from any folder, including those missed by per-folder IDLE.

**Recommendation:** Option A (per-folder CHANGEDSINCE on IDLE wake) — simpler, uses existing CONDSTORE infrastructure, no new folder dependency.

**Files to change:**
- `kylins.client.backend/src/sync_engine/imap_source.rs` — In `watch()` loop, after IDLE returns, issue `FETCH CHANGEDSINCE` to also detect expunges
- `kylins.client.backend/src/sync_engine/engine.rs` — Ensure the Yahoo-specific IDLE handler triggers an expunge check round

### P2 — Use MOVE for Atomic Operations

**Problem:** Kylins' `move_messages` currently does `COPY` + `STORE \Deleted` + `EXPUNGE`. Yahoo supports `UID MOVE` which is:
- **Atomic** — no partial state (message copied but not deleted)
- **Quota-friendly** — single copy exists throughout (no temporary duplication)
- **Faster** — one round-trip instead of three

**Example:**
```
C: A015 UID MOVE 44627 Trash
S: * OK [COPYUID 1631320479 44627 7]
S: * 37727 EXPUNGE
S: * 37730 EXISTS
S: A015 OK UID MOVE completed
```

**Files to change:**
- `kylins.client.backend/src/mail/imap/client.rs` — Add `uid_move(uid_set, dest_mailbox)` method
- `kylins.client.backend/src/sync_engine/imap_source.rs` — In `move_messages()`, detect Yahoo via capabilities and use `MOVE` instead of COPY+DELETE+EXPUNGE

### P3 — LIST-STATUS for Folder Discovery

**Problem:** Kylins' `list_folders` issues a `LIST` command then N separate `STATUS` commands (one per folder) to get message counts, unseen, UIDNEXT, UIDVALIDITY, and HIGHESTMODSEQ. Yahoo supports `LIST-STATUS` which returns all this in a single `LIST` response.

**Before (N+1 round-trips):**
```
C: A001 LIST "" "*"
C: A002 STATUS "INBOX" (MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ)
C: A003 STATUS "Sent" (MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ)
C: A004 STATUS "Drafts" (MESSAGES UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ)
...
```

**After (1 round-trip):**
```
C: A001 LIST "" "*" RETURN (STATUS (MAILBOXID MESSAGES RECENT UNSEEN UIDNEXT UIDVALIDITY HIGHESTMODSEQ))
```

Response includes per-folder MAILBOXID, MESSAGES, RECENT, UIDNEXT, UIDVALIDITY, UNSEEN, HIGHESTMODSEQ in a single server response.

**Files to change:**
- `kylins.client.backend/src/mail/imap/client.rs` — Add `list_with_status(reference, pattern)` method
- `kylins.client.backend/src/sync_engine/imap_source.rs` — In `list_folders()`, use `LIST-STATUS` when capabilities include `LIST-STATUS` (RFC 5819)

### P4 — OBJECTID for Stable Message Identity

**Problem:** Kylins assigns local UIDs by hashing opaque server IDs with FNV (see `eas_source.rs:249-252` and `imap_source.rs`). For Yahoo, `EMAILID`, `THREADID`, and `MAILBOXID` are persistent, unique identifiers:
- **MAILBOXID** — survives RENAME (no re-download after folder rename)
- **EMAILID** — survives MOVE (track the same message across folders)
- **THREADID** — built-in conversation grouping

**Fix:** Fetch OBJECTID metadata during sync and store in `messages` table alongside existing IMAP UID fields.

**Example fetch:**
```
C: A010 UID FETCH 44627:44631 (UID MAILBOXID EMAILID THREADID)
```

**Benefits:**
- No FNV hash collisions (EMAILID is guaranteed unique)
- Messages remain trackable after MOVE (EMAILID persists)
- Thread grouping without subject-based heuristics (THREADID)
- Folder renames don't trigger re-download (MAILBOXID)

**Files to change:**
- `kylins.client.backend/src/db/messages.rs` — Add optional `y_email_id`/`y_thread_id` columns (or reuse `gmail_message_id`/`gmail_thread_id` as generic `remote_message_id`/`remote_thread_id`)
- `kylins.client.backend/src/mail/imap/client.rs` — Add OBJECTID to standard FETCH macro
- `kylins.client.backend/src/sync_engine/imap_source.rs` — Map OBJECTID fields to remote IDs in `RemoteMessage`

### P5 — All Mail Virtual Folder for Single-Folder Sync

**Problem:** Kylins syncs each folder independently (INBOX, Sent, Drafts, Trash, etc.). Yahoo exposes an "All Mail" virtual folder that contains **every message across all folders** with `MAILBOXID` indicating the source folder. Combined with CONDSTORE + QRESYNC, this enables:

- **Initial sync:** Fetch all messages via "All Mail" in one pass (not one pass per folder)
- **Delta sync:** One `FETCH CHANGEDSINCE` on "All Mail" catches new messages, flag changes, AND deletes from all folders
- **Delete detection:** "All Mail" publishes deletions that per-folder IDLE misses

**Example:** Message in "All Mail" with `MAILBOXID (1)` = Inbox, `MAILBOXID (4)` = Trash, etc.

**Fix:** Add an optional "All Mail" sync path for Yahoo accounts. When enabled:
1. Select "All Mail" folder
2. Initial sync: paginate via `PARTIAL` to get full history
3. Delta sync: `FETCH CHANGEDSINCE (last_modseq)` to get changes since last sync
4. Route messages to local labels based on MAILBOXID

**Trade-off:** "All Mail" is labeled "Experimental" by Yahoo. It's a superset optimization — privacy/performance concerns (downloading Trash/Spam messages). Keep as opt-in.

**Files to change:**
- `kylins.client.backend/src/sync_engine/imap_source.rs` — New sync path for "All Mail" folder
- `kylins.client.backend/src/db/labels.rs` — Map MAILBOXID → label route

### P6 — OAUTHBEARER for OAuth2 IMAP/SMTP Auth

**Problem:** Yahoo uses app-password (PLAIN AUTH) as the current auth path. The server advertises `AUTH=OAUTHBEARER` for OAuth2. When Yahoo approves OAuth2 client credentials for Kylins, the auth path can switch.

**SASL-IR single-round-trip:**
```
C: A001 AUTHENTICATE OAUTHBEARER bixhPXVzZXJAeWFob28uY29tLAE...
S: A001 OK AUTHENTICATE completed
```

The base64 payload encodes: `n,a=user@yahoo.com,\001host=imap.mail.yahoo.com\001port=993\001auth=Bearer <token>\001\001`

**SMTP XOAUTH2:**
```
C: AUTH XOAUTH2 <base64>
```

The base64 payload encodes: `user=user@yahoo.com\001auth=Bearer <token>\001\001`

**Files to change:**
- `kylins.client.backend/src/mail/imap/client.rs` — Add `AUTHENTICATE OAUTHBEARER` path, gated on OAuth2 token presence + `AUTH=OAUTHBEARER` capability
- `kylins.client.backend/src/mail/smtp/client.rs` — Add `AUTH XOAUTH2` path
- `kylins.client.frontend/src/services/auth/providers.ts` — Yahoo OAuth2 config (skeleton until client credentials approved)

---

## Implementation Phases

### Phase 1: Unlock Full Mailbox (P0 + P1) — Critical
| Task | Effort | Impact |
|------|--------|--------|
| Detect Yahoo via IMAP `ID` command response | 1h | Foundation for all Yahoo-specific optimizations |
| Send `ENABLE UIDONLY` on connect for Yahoo accounts | 1h | **Unlocks full mailbox** (>1000 messages per folder) |
| Post-IDLE CHANGEDSINCE expunge detection | 2h | Fixes silent delete bug for Yahoo accounts |

### Phase 2: Efficient Operations (P2 + P3) — High Value
| Task | Effort | Impact |
|------|--------|--------|
| `UID MOVE` for Yahoo accounts | 2h | Atomic moves, no quota impact |
| `LIST-STATUS` for folder discovery | 1.5h | Cuts folder listing from N+1 to 1 round-trip |

### Phase 3: Stable Identity & Full Sync (P4 + P5) — Optional/Advanced
| Task | Effort | Impact |
|------|--------|--------|
| OBJECTID (EMAILID/THREADID/MAILBOXID) | 3h | Stable IDs, no collisions, cross-folder tracking |
| "All Mail" folder sync path | 4h | Single-folder full-mailbox initial + delta sync |

### Phase 4: OAuth2 Readiness (P6) — Future
| Task | Effort | Impact |
|------|--------|--------|
| OAUTHBEARER IMAP auth path | 2h | Ready when OAuth2 client credentials obtained |
| XOAUTH2 SMTP auth path | 1h | Ready for OAuth2 SMTP |

---

## Key Risks & Notes

| Item | Note |
|------|------|
| **UIDONLY mode is all-or-nothing** | Once enabled, MSN-based commands fail. Must ensure all command paths use UID variants. |
| **IDLE expunge gap** | Even with CHANGEDSINCE, there's a race between IDLE wake and the re-fetch. Acceptable for a desktop client at 60s poll intervals. |
| **"All Mail" is experimental** | May change or be removed. Use as opt-in optimization, not a hard dependency. |
| **AOL shares infrastructure** | Same `imap.mail.yahoo.com` server; same capabilities. AOL accounts get all the same optimizations automatically. |
| **MESSAGELIMIT per-response in UIDONLY** | Even in UIDONLY mode, a single FETCH/SEARCH response is capped at MESSAGELIMIT results. Use `PARTIAL` pagination for large batches. |
| **OBJECTID across MOVE** | EMAILID persists when a message is moved to Trash. This means a Trashed message can be tracked back to its original folder — useful for undo. |
| **Server hostname** | Yahoo IMAP identifies as `Y!IMAP` on `jimap{node}.imap.mail.yahoo.yahoo.cloud`. Detect via IMAP `ID` response, not hostname. |
