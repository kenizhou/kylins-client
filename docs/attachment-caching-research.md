# Attachment Caching Research — Velo, Thunderbird & Mailspring

Research conducted 2026-07-07. Covers how each reference codebase stores, caches, and cleans up email attachments on disk.

---

## Quick Comparison

| Aspect | **Velo** | **Thunderbird** | **Mailspring** |
|--------|----------|-----------------|----------------|
| **Strategy** | Hybrid (eager pre-cache bg poller + lazy reads) | Lazy (on-demand, user-click triggers fetch) | Eager (pre-fetch during sync, 3-month window) |
| **Storage location** | `AppData/attachment_cache/` (flat dir) | Inside mbox/maildir message files | `AppData/files/<cc>/<dd>/<id>/` (sharded) |
| **File naming** | DJB2 hash of UUID (e.g. `2x9z_4y1k`) | N/A — embedded in mbox | Base58 SHA-256 sharded path + sanitized filename |
| **Metadata** | SQLite `attachments` table (13 cols) | In-memory MIME re-parse each time | SQLite `File` table (JSON blob) |
| **IMAP fetch** | `BODY.PEEK[]` full msg (inefficient) | `BODY.PEEK[part]` per-part (efficient) | Full message fetch |
| **Cleanup/eviction** | Manual button only; `evictOldestCached` exists but never called | Mbox compaction + cache2 LRU | MessageBody DELETE at 14d age; **attachment files leaked** (explicit TODO) |
| **Preview caching** | ❌ None | ❌ None | ✅ `.png` alongside file |
| **Configurable max** | ✅ 100MB–2GB slider in Settings | ❌ Implicit (cache2 size) | ❌ None |
| **Temp files for open** | N/A (bypasses cache) | ✅ `pid-{PID}` dir, auto-cleanup on exit | N/A (opens from cache) |

---

## Velo (reference implementation)

### Directory & Naming

```
C:\Users\<user>\AppData\Roaming\com.velomail.app\attachment_cache\
  2x9z_4y1k
  7abc_3def
  ...
```

- **Root:** `BaseDirectory.AppData` → `attachment_cache/`
- **Structure:** Flat — all files in one directory, no subdirectories
- **Naming:** `hashFileName(id)` — dual DJB2 hash of attachment UUID, produces names like `2x9z_4y1k`. No file extension.
- **Creation:** Lazy — directory is `mkdir(recursive: true)` only when the first attachment is cached.

### SQLite Schema

The `attachments` table is created in migration v1 and extended in v5 and v14:

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  gmail_attachment_id TEXT,
  content_id TEXT,
  is_inline INTEGER DEFAULT 0,
  local_path TEXT,
  cached_at INTEGER,       -- added in v5
  cache_size INTEGER,       -- added in v5
  imap_part_id TEXT,        -- added in v14
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);
```

Default cache max: `500` MB (stored in settings key `attachment_cache_max_mb`).

### Caching Strategy: Hybrid (incomplete)

**Eager pre-cache** (`src/services/attachments/preCacheManager.ts`):
- Background poller runs every **15 minutes** (900,000 ms)
- Skips when offline or cache ≥ max size
- Only fetches: non-inline, ≤**5 MB**, ≤**7 days** old
- Batch-limited to **20 attachments** per run
- Uses `provider.fetchAttachment()` to get data, then `cacheAttachment(id, binary)` to write

**Lazy reads** (`src/services/attachments/cacheManager.ts`):
- `loadCachedAttachment()` is **defined but never called** by any production code
- All UI components (`EmailRenderer`, `InlineAttachmentPreview`, `AttachmentList`, `AttachmentLibrary`) call `provider.fetchAttachment()` directly — **bypassing the disk cache entirely**
- This is a significant missing optimization: cache is written eagerly but never read

### Cleanup & Eviction

- `evictOldestCached()` — LRU-based eviction by `cached_at` ASC. Removes files until under max. **Never called automatically** — no trigger in cache writes or background job.
- `clearAllCache()` — Recursively deletes `attachment_cache/` dir, resets all `cached_at` rows. Only triggered by user clicking "Clear Cache" in Settings → Storage.
- Settings UI: Shows current usage (MB), slider for max (100/250/500/1000/2000 MB), Clear button.

### IMAP Fetch Inefficiency

`src-tauri/src/imap/client.rs:570-640` — `fetch_attachment()` does `BODY.PEEK[]` (downloads the **entire message**) then parses MIME to extract a single part, instead of using `BODY.PEEK[part]` for targeted fetch.

### Key Source Files

| File | Purpose |
|------|---------|
| `src/services/attachments/cacheManager.ts` | Core disk cache: write, read (unused), size query, evict, clear |
| `src/services/attachments/preCacheManager.ts` | Background prefetch poller (15 min) |
| `src/services/db/migrations.ts` | SQLite schema (attachments table + cache columns) |
| `src/services/email/imapSmtpProvider.ts:240-253` | IMAP fetch entry point |
| `src/services/email/gmailProvider.ts:132-138` | Gmail fetch entry point |
| `src-tauri/src/imap/client.rs:570-640` | Low-level Rust IMAP fetch (full message) |
| `src/App.tsx:336` | `startPreCacheManager()` on app startup |

---

## Thunderbird

### Architecture: No Separate Attachment Cache

Attachments are **not cached separately** — they live inside the complete message stored in the offline store. Thunderbird has two storage formats:

| Store | Description | Compaction? | storeToken |
|-------|-------------|-------------|------------|
| **mbox** (default) | Single file per folder, `From ` delimiters | Yes (required) | Byte offset in mbox |
| **maildir** | One file per message per folder | No | Filename |

### Directory Layout

```
<profile>/
  Mail/
    <Local Folders>/
      Inbox              ← mbox file (no extension)
      Inbox.msf          ← Mork summary/database file
      Sent
      Sent.msf
  ImapMail/
    imap.example.com/
      INBOX              ← mbox file (offline storage)
      INBOX.msf          ← Mork summary/database file
      INBOX.sbd/         ← subfolder directory
  cache2/                ← Necko HTTP-style hot cache (SQLite-backed)
```

The `.msf` files (Mork Summary Files) contain per-message metadata (flags, keys, threads, store tokens). There is **no dedicated attachment metadata** — MIME structure is discovered by re-parsing the message when needed.

### Caching Strategy: Purely Lazy / On-Demand

1. **Folder open** → headers only: `FETCH (BODY.PEEK[HEADER.FIELDS (...)])`
2. **User clicks message** → full body: `FETCH (BODY.PEEK[])` → rendered + cached to offline store + cache2
3. **User opens attachment** → part-only: `FETCH (BODY.PEEK[part])` via `imap-message://` URL scheme

**Two-layer cache:**
- **Offline store** (persistent): Full messages in mbox/maildir
- **Necko cache2** (transparent hot cache): IMAP responses cached in `<profile>/cache2/` with SQLite backend, acts as a "hot" layer on top of the "cold" offline store

### IMAP Fetch: Part-Selective

Thunderbird's IMAP fetch is **efficient** — it uses targeted FETCH commands:

| Command | Purpose |
|---------|---------|
| `kEveryThingRFC822` | `FETCH <uid> (BODY[])` — full message |
| `kMIMEPart` | `FETCH <uid> (BODY.PEEK[<part>])` — single MIME part, no \Seen flag |
| `kMIMEHeader` | `FETCH <uid> (BODY[<part>.MIME])` — MIME header for a part |
| Headers only | `FETCH <uid> (BODY.PEEK[HEADER.FIELDS (...)])` |

The `.PEEK` variant does not set the `\Seen` flag on the server.

### Attachment URL Scheme

Attachments are addressed via URL-encoded MIME part references:
```
imap-message://user@example.com/INBOX#12345?part=1.2
```

The `?part=1.2` encodes the MIME part address. For IMAP, headers `X-Mozilla-IMAP-Part` and `X-Mozilla-External-Attachment-URL` carry the server-specific part identifier.

### Temp Files for Opening Attachments

`mail/modules/AttachmentInfo.sys.mjs:327-341`:
- Temp directory: `PathUtils.tempDir/pid-{PID}/`
- Permissions: `0o700` dir, `0o600` file
- Cleanup: `deleteTemporaryFileOnExit()` — guaranteed on app exit
- Caches `message/rfc822` attachments in a `Map` keyed by URL to avoid re-download

### Cleanup & Eviction

Thunderbird has **no attachment-specific cache eviction**. Cleanup mechanisms:

1. **Mbox compaction** — Physically removes messages marked `X-Mozilla-Status: Expunged` from mbox files. Primary cleanup for deleted messages/attachments.
2. **Necko cache2 eviction** — Size-based LRU in `<profile>/cache2/`. Large entries rejected via `CacheObserver::EntryIsTooBig()`.
3. **Temp file cleanup** — `deleteTemporaryFileOnExit()` on app exit.
4. **Attachment deletion/detachment** — User can delete (replaced with `text/x-moz-deleted` placeholder) or detach (saved to disk, replaced with `file://` link).

### Key Source Files

| File | Purpose |
|------|---------|
| `mailnews/mime/src/mimei.cpp` | MIME class resolution, part address construction |
| `mailnews/mime/src/mimemoz2.cpp` | Bridge: MIME → frontend attachment list |
| `mailnews/imap/src/nsImapProtocol.cpp:3600-3774` | IMAP FETCH command construction (all modes) |
| `mailnews/imap/src/nsImapProtocol.cpp:8798-8950` | Necko cache2 integration for IMAP |
| `mailnews/imap/src/nsImapMailFolder.cpp:4108-4416` | Offline store write stream + cache release |
| `mailnews/base/public/nsIMsgPluggableStore.idl` | Message storage abstraction (mbox/maildir) |
| `mailnews/base/public/nsIMsgMessageService.idl:209-226` | `nsIMsgMessageFetchPartService` interface |
| `mail/modules/AttachmentInfo.sys.mjs` | Frontend attachment class (fetch, save, open, temp) |
| `mailnews/local/src/MboxCompactor.cpp` | Mbox compaction (cleanup of deleted messages) |

---

## Mailspring

### Directory & Naming: Sharded Hash Tree

```
%APPDATA%/Mailspring/files/
  a1/                       ← file.id[0:2]
    b2/                     ← file.id[2:4]
      a1b2c3d4...full-id/   ← full SHA-256→Base58 ID as directory
        report.pdf          ← sanitized user-visible filename
        report.pdf.png      ← preview thumbnail (if generated)
```

- **Root:** `CONFIG_DIR_PATH + "/files"` — on Windows: `%APPDATA%/Mailspring/files`
- **Sharding:** First 4 hex chars of file ID → 2-level directory tree (~256×256 = 65K buckets)
- **File ID:** `SHA-256(messageId:accountId:partID:uniqueID)` → Base58 → lowercase
- **Filename:** `safeFilename()` / `safeDisplayName()` — strips `\/:|?*><"#` + control chars + Windows reserved names (CON, PRN, etc.)
- **Preview:** Adjacent `{filepath}.png`

### SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS `File` (
    id VARCHAR(40) PRIMARY KEY,
    version INTEGER,
    data BLOB,           -- JSON metadata blob (not file bytes)
    accountId VARCHAR(8),
    filename TEXT
);
```

The `data` BLOB is a JSON object containing: `messageId`, `partId`, `contentId`, `contentType`, `filename`, `size`. Actual attachment bytes are **filesystem-only** — SQLite stores only metadata.

`MessageBody` table stores HTML body text separately with a `fetchedAt` timestamp.

### Caching Strategy: Eager Pre-Fetch

During sync, `SyncWorker::syncMessageBodies()` queries for messages missing bodies:

```sql
SELECT Message.id FROM Message
LEFT JOIN MessageBody ON MessageBody.id = Message.id
WHERE Message.date > <3 months ago>   -- 3-month window
  AND Message.draft = 1 OR MessageBody.id IS NULL
ORDER BY Message.date DESC LIMIT 30   -- batch of 30
```

- **Age window:** Messages ≤**3 months** old (constant: `24 * 60 * 60 * 30 * 3`)
- **Excluded:** Spam and Trash folders (`shouldCacheBodiesInFolder()` returns false)
- **Batch size:** 30 messages per sync cycle
- **Fetch method:** Full IMAP message fetch (`session.fetchMessageByUID()`), then `mailcore` MIME parser extracts all parts
- **No "body-only" mode** — entire message (including all attachments) is always downloaded
- Drafts are **always** fetched regardless of age

### Attachment Data Flow

1. **SyncWorker::syncMessageBody()** — IMAP `UID FETCH` for full RFC 2822 message
2. **MessageParser::htmlRenderingAndAttachments()** — mailcore parses MIME, returns HTML body + `htmlInlineAttachments` + `partAttachments`
3. **MailProcessor::retrievedFileData()** — For each attachment, constructs sharded path via `MailUtils::pathForFile()`, writes bytes via `mailcore::Data::writeToFile()`
4. **INSERT** into SQLite `File` table (metadata only) and `MessageBody` table (HTML body)
5. **Frontend read:** `AttachmentStore.pathForFile()` reconstructs the same sharded path, verifies file exists

### Draft Attachments

When attaching a file to a draft, the file is **copied** from its original location into the `files/` cache (`_copyToInternalPath()`). Max size: 25 MB.

When sending, the C++ process reads the file back from the same `files/` cache location.

### Preview / Thumbnail Generation

`_ensurePreviewOfFile()` generates a `.png` thumbnail alongside the original:
- Stored as `{filepath}.png`
- Uses multiple strategies: macOS QuickLook, PDF.js, Mammoth (DOCX), Snarkdown (MD), Prism (code), XLSX parser
- Token-based security: renderer cannot specify arbitrary paths; main process validates against `files/` base dir

### Cleanup & Eviction: Incomplete

**Message body cleanup** runs every `CACHE_CLEANUP_INTERVAL` (1 hour), only when folder is fully synced:

```sql
DELETE FROM MessageBody
WHERE MessageBody.fetchedAt < datetime('now', '-14 days')
  AND MessageBody.id IN (
    SELECT Message.id FROM Message
    WHERE Message.remoteFolderId = ? AND Message.draft = 0
      AND Message.date < ?   -- >3 months old
  );
```

**Critical gap:** The code has an explicit TODO at `MailProcessor.cpp:1012`:
```cpp
// TODO BG: Remove them from the search index and remove attachments
```
The `MessageBody` rows are deleted but the actual attachment files under `files/` are **not removed**. This is a known leak.

**Account deletion** also leaks: `DELETE FROM File WHERE accountId = ?` removes rows but not files.

**Draft attachment deletion** IS correctly implemented: `_deleteFile()` calls `fs.unlinkAsync()` + `fs.rmdirAsync()`.

### IPC Security

`quickpreview-ipc.ts:44-55` enforces `files/` directory boundary for all renderer-process file access, preventing path traversal attacks.

### Key Source Files

| File | Purpose |
|------|---------|
| `mailsync/MailSync/MailUtils.cpp:434-448` | `pathForFile()` — sharded directory construction |
| `mailsync/MailSync/MailUtils.cpp:544-566` | `idForFile()` — SHA-256 → Base58 ID generation |
| `mailsync/MailSync/MailProcessor.cpp:336-503` | `retrievedMessageBody()` + `retrievedFileData()` |
| `mailsync/MailSync/SyncWorker.cpp:1001-1072` | `syncMessageBodies()` + `cleanMessageCache()` |
| `mailsync/MailSync/constants.h:59` | SQLite `File` table schema |
| `app/src/flux/stores/attachment-store.ts` | Frontend: pathForFile, add/delete/preview |
| `app/src/browser/quickpreview-ipc.ts` | Main-process IPC with files/ boundary check |
| `mailsync/MailSync/TaskProcessor.cpp:1528-1538` | Read back attachments for SMTP send |

---

## Design Recommendations for Kylins Client

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| **Separate attachment cache** | ✅ Yes (Velo/Mailspring pattern) | Decouples attachment lifecycle from message lifecycle; enables independent size-based pruning |
| **Sharded directories** | ✅ Mailspring's 2-level shard | Velo's flat dir hits FS perf issues at scale; 256×256 buckets is proven |
| **Fetch strategy** | Prefer Thunderbird's lazy model | Velo eagerly caches but never reads; Mailspring downloads 3 months blindly. Lazy + cache-on-first-read wastes less bandwidth |
| **IMAP partial fetch** | ✅ `BODY.PEEK[part]` | Thunderbird does this; Velo's full-message-then-parse is wasteful for large attachments |
| **Metadata in SQLite** | Velo's schema as starting point | Track `cached_at`, `cache_size` for LRU; `imap_part_id` for efficient refetch |
| **Cache eviction** | LRU eviction on write, not just background | Velo has the code but never calls it; Mailspring leaks files entirely |
| **Preview cache** | Adjacent `.png` (Mailspring pattern) | Avoids re-generating thumbnails; clean up alongside the attachment |
| **Temp files for open** | OS temp + `pid-{PID}` + restricted perms | Thunderbird's approach is the safest (auto-cleanup on exit) |
| **Configurable max** | ✅ User-facing slider | Velo's Settings UI is a good reference |
| **IPC security** | ✅ Validate paths within cache root | Mailspring's `quickpreview-ipc.ts` boundary check prevents path traversal |
