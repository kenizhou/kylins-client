# Design: Improve Kylins Client Contacts / Address Book from Reference Codebases

**Date:** 2026-06-27  
**Scope:** Contacts / address book subsystem  
**References studied:** Velo, inbox-zero, Mailspring, Thunderbird  
**Status:** Draft — pending approval

---

## Context

Kylins Client already has a surprisingly complete local address-book foundation: a rich `contacts` schema, frontend CRUD service, Zustand store, full Contacts page UI, vCard import/export IPC, and contact-backed composer autocomplete. The goal of this design is to **validate the existing foundation against four mature reference codebases**, identify the highest-value gaps, and produce a phased implementation plan.

**Governance from project memory:** Velo is the architecture owner; Mailspring is the feature donor. Thunderbird is a requirements/spec reference (XPCOM/libical code is not portable). inbox-zero is informative for web-era patterns but its live Google-People-only model is inappropriate for an offline-first desktop client.

## Zen Optimization Notes

After the initial synthesis, zen analysis was used to stress-test assumptions. Key refinements applied:

- **Add a prerequisite Phase 0 for index + batch-load command.** ReadingPane and MessageList will hit the contacts table on every render; an index on normalized email and a batch-loading Rust command prevent N+1 plugin-sql queries.
- **Split Phase 1 into shippable increments:** UI enrichment first, then throttled incoming-mail seeding, then Gravatar. Each increment is independently testable.
- **Incoming-mail seeding needs confidence scoring and throttling.** A full mailbox sync could create thousands of unwanted contacts. Seed only addresses that appear multiple times, are replied to, or are in To/Cc of outgoing mail.
- **Combine Rust DB command cutover and FTS into one phase.** Avoid two churn cycles; add the FTS5 virtual table and triggers in the same migration that cuts contacts over to Rust commands.
- **CardDAV requires explicit multi-source merge semantics.** When the same email exists in iCloud and Nextcloud, the global contact row must merge deterministically (manual > CardDAV A > inferred > CardDAV B) while preserving each source's raw vCard in `contact_sync_state`.
- **Gravatar needs local image cache + opt-in.** Store downloaded avatars locally (not just URLs) and make fetching opt-in per account for privacy.
- **Testing is mandatory for CardDAV.** Build a mock CardDAV server in Rust tests before touching real backends.

---

## Reference Learnings (What Matters for Kylins)

### Velo (closest stack match — Tauri 2 / React 19 / SQLite)
- **Storage:** Single global SQLite `contacts` table (not per-account) with `email UNIQUE`, `display_name`, `avatar_url`, `frequency`, `last_contacted_at`, `notes`.
- **Auto-create:** `upsertContact(email, name)` called on every composer/inline-reply send; bumps `frequency` and `last_contacted_at`.
- **UI:** `ContactEditor` in Settings, `ContactSidebar` in reading pane, `AddressInput` chip autocomplete with debounced `searchContacts`.
- **Avatar:** Custom MD5 Gravatar fetcher with DB caching.
- **Sync:** None — contacts are purely local, derived from email traffic.

### inbox-zero (Next.js / Prisma / Google People API)
- **Storage:** No local `Contact` table. `Newsletter` and `EmailMessage` store sender data.
- **Autocomplete:** Live search against Google People API in composer only; feature-flagged.
- **CRUD:** None — read-only against Google.
- **Desktop relevance:** Confirms that a desktop offline-first client needs a local store, not live cloud search.

### Mailspring (Electron / Flux / C++ sync worker)
- **Storage:** `Contact`, `ContactSearch` (FTS5), `ContactBook`, `ContactGroup` tables; rich `info` blob for VCF/Google JSON.
- **Mutations:** Flux tasks (`SyncbackContactTask`, `DestroyContactTask`, `ChangeContactGroupMembershipTask`) queued to C++ `TaskProcessor`.
- **Sync backends:** CardDAV `DAVWorker` and Google Contacts `GoogleContactsWorker`.
- **UI:** Full address-book package (`ContactList`, `ContactDetailEdit`, `ContactDetailRead`, `ContactPerspectivesList`), drag-and-drop groups, VCF import/export.
- **Composer:** `TokenizingTextField` with contact-group expansion.
- **Takeaway:** Use the sync architecture concept (local delta + remote worker) but adapt it to Kylins' simpler Rust command model.

### Thunderbird (XUL/XPCOM/libical)
- **Data model:** vCard-native `nsIAbCard`; multiple backends (SQLite, CardDAV, LDAP, OS address books).
- **Manager:** `AddrBookManager` with email-to-card cache; display-name version invalidation.
- **Sync:** CardDAV `sync-collection` with sync-token, fallback to PROPFIND + multiget; offline change queue.
- **Feature checklist:** Multiple backends, structured names, multiple emails/phones/addresses, groups/lists, FTS autocomplete, composer integration, import/export (vCard/CSV/LDIF), photo support, observer notifications, read-only directories.
- **Takeaway:** Use as the maturity checklist, not as code to port.

---

## Design Decisions

| Area | Decision | Rationale |
|------|----------|-----------|
| **Architecture owner** | Velo | Stack match; Kylins already mirrors Velo's global contacts table and auto-upsert pattern. |
| **Feature donor** | Mailspring for desktop address-book features (FTS, groups, VCF round-trip, CardDAV worker concepts); Thunderbird for CardDAV sync-token semantics. | Keeps code portable and aligns with Kylins structure. |
| **Storage model** | Keep existing global `contacts` table with `account_id`/`source` columns. | Schema already supports rich contacts + groups + sync state. Avoids migration churn. |
| **Multi-source merge** | Merge on normalized email with deterministic priority: `manual` > `carddav:<account>` > `inferred`. Store each source's raw vCard in `contact_sync_state`. | Prevents duplicates while preserving per-source fidelity and enabling source-specific deletes. |
| **DB access** | Cut contacts CRUD over to Rust `db_*` commands in Phase 2. | Aligns with the recent DB cutover; frontend should only read via commands. |
| **Search** | FTS5 virtual table `contact_search` with triggers on `contacts`. | Mailspring/Thunderbird pattern; fast ranked autocomplete across names, emails, company, notes. |
| **Avatar** | Gravatar with local file cache, opt-in per account. | Velo pattern adapted for desktop (local cache for offline use and privacy). |
| **Sync** | CardDAV first; Google People and EAS GAL deferred. | CardDAV is provider-agnostic (Nextcloud, iCloud, Fastmail). Google People requires OAuth scope and API-specific mapping. |
| **Incoming seeding** | Throttled, confidence-scored, domain-blocked. | Avoids address-book pollution during large syncs. |

---

## Recommended Roadmap

### Phase 0 — Prerequisites: Index + Batch-Load Command

**Goal:** Make contact enrichment fast enough to ship in every message view.

1. **Schema/index migration**
   - Add `email_lower` generated column (or ensure `email` is stored normalized).
   - Add index `idx_contacts_email_lower` on lowercased email.
   - Add index `idx_contacts_frequency` for autocomplete ranking.

2. **Rust batch command**
   - Create `db_get_contacts_by_emails(emails: Vec<String>) -> Vec<Contact>` in `kylins.client.backend/src/commands.rs`.
   - Returns all contacts matching the provided emails in a single query.
   - This will be used by ReadingPane and MessageList instead of one plugin-sql query per sender.

**Verification:**
- `cargo test` for the new command.
- Render a 1000-message list without per-row contact queries.

---

### Phase 1a — UI Enrichment (Highest User Value)

**Goal:** Make the existing rich contact data visible in mail view, composer, and message list.

1. **ReadingPane sender enrichment**
   - Modify `src/components/layout/ReadingPane.tsx` to call `getContactByEmail(message.from.address)`.
   - Display contact `avatar_url` (or Gravatar/initials fallback), preferred `display_name`, `company`, and `job_title`.
   - Add a "Show contact card" action that opens the contact sidebar.

2. **MessageList sender enrichment**
   - Modify `src/components/mail/MessageList.tsx` to batch-resolve sender emails via the Phase 0 Rust command.
   - Use `contact.display_name` when available; fallback to `thread.fromName` / `thread.fromAddress`.
   - Show contact avatar in thread rows (use cached avatar or initials).

3. **Contact sidebar in mail view**
   - Create `src/features/viewer/ContactSidebar.tsx` (port Velo pattern).
   - Show avatar, name, email, company, job title, notes, recent threads, same-domain contacts, group membership.
   - Actions: Compose, Copy email, Edit contact, Add/remove groups.
   - Modify `ReadingPane.tsx` / `ReadingPaneLayout.tsx` to render the sidebar when `uiStore.contactSidebarVisible` is true.
   - Add toggle button in `ActionBar.tsx` or `ReadingPane.tsx` toolbar.

4. **Composer "From" selector enrichment**
   - Modify `FromSelector.tsx` to resolve the active account's email to a contact and show avatar/preferred name.

**Verification:**
- ReadingPane shows contact avatar + company for a known sender.
- MessageList uses contact display names and avatars.
- Toggle sidebar shows enriched contact card.
- Composer From shows account contact avatar.

---

### Phase 1b — Incoming-Mail Contact Seeding

**Goal:** Auto-populate the address book from received mail without polluting it with one-off senders.

1. **Seeding service**
   - Create `src/services/contacts/seedFromMail.ts`.
   - During message sync/parsing (or after `db_*` message insert), collect normalized `From`, `To`, `Cc` addresses.
   - Skip system addresses: `noreply-*`, `donotreply-*`, `no-reply-*`, `mailer-daemon*`, `postmaster*`, `listserv*`, plus any address with no display name and a generic local part.

2. **Confidence scoring**
   - Score +2 if the address appears in outgoing mail (To/Cc of sent messages).
   - Score +1 per received message, capped at 5.
   - Score +3 if the thread is starred or marked important.
   - Only create/update a contact when score >= 2, or if the address is in `To`/`Cc` of an outgoing message.

3. **Throttling / batching**
   - Maintain an in-memory dedup set per sync session; flush `upsertContact` calls every 30s or at end of sync.
   - For initial large sync, cap inferred contact creation to the top N by frequency per day.

4. **Source tracking**
   - Set `source = 'inferred'` and `account_id = null` for seeded contacts.
   - Allow users to "promote" an inferred contact to `manual` from the contact detail view.

**Verification:**
- Send an email to a new address → contact created with `source='manual'` (existing behavior).
- Receive 3+ messages from a human sender → inferred contact appears.
- Receive 1 message from `noreply@example.com` → no contact created.

---

### Phase 1c — Gravatar Avatar Fetching

**Goal:** Populate contact avatars automatically with privacy-respecting caching.

1. **Avatar service**
   - Create `src/services/contacts/avatar.ts`.
   - `fetchGravatarUrl(email)` using MD5 hash (port Velo's custom MD5 or use a small library).
   - HEAD Gravatar; on 200, download image to Tauri app-local data directory (`app_local_data/contacts/avatars/<hash>.png`).
   - Store local file path/URI in `contacts.avatar_url`.

2. **Opt-in setting**
   - Add global preference `loadExternalContactAvatars` (default false).
   - Add per-account preference `account.loadExternalAvatars`.
   - Only fetch when at least one is true.

3. **Integration**
   - Modify `ContactAvatar.tsx` to use `avatar_url` if present, else initials fallback.
   - Call avatar fetch lazily when a contact is first rendered in ReadingPane/MessageList/ContactSidebar.

**Verification:**
- Known sender with Gravatar shows avatar after opt-in.
- Avatar file exists in local cache and renders offline.
- No network request when opt-in is disabled.

---

### Phase 2 — Rust DB Commands + FTS

**Goal:** Align contacts with the Rust DB cutover and enable fast ranked search.

1. **Rust DB commands**
   - Create `kylins.client.backend/src/db/contacts.rs` with commands mirroring `src/services/db/contacts.ts`:
     - `db_get_contacts`, `db_search_contacts`, `db_get_contact_by_id`, `db_get_contact_by_email`, `db_create_contact`, `db_update_contact`, `db_delete_contact`, `db_upsert_contact`.
   - Add group commands: `db_get_contact_groups`, `db_create_contact_group`, `db_rename_contact_group`, `db_delete_contact_group`, `db_add_contact_to_group`, `db_remove_contact_from_group`.
   - Register all commands in `commands.rs`.

2. **Frontend adapter**
   - Create `src/services/db/contactsCommands.ts` as a thin wrapper over `invoke('db_*')`.
   - Refactor `src/services/db/contacts.ts` to call the command wrapper, preserving the existing API so UI components don't change.
   - Alternatively, replace direct plugin-sql calls in UI with the command service.

3. **FTS5 virtual table**
   - Migration: create `contact_search` FTS5 table indexing `display_name`, `company`, `job_title`, `emails_json`, `notes`.
   - Add INSERT/UPDATE/DELETE triggers on `contacts` to keep `contact_search` in sync.
   - Add `db_search_contacts_fts(query, limit)` Rust command returning ranked results.

4. **Autocomplete upgrade**
   - Modify `RecipientField.tsx` to use `db_search_contacts_fts` when query length > 1.
   - Fall back to prefix search for very short queries.
   - Rank by frequency + match quality.

**Verification:**
- All existing contacts tests pass after adapter refactor.
- `cargo test` for new Rust commands.
- Search "Acme" returns contacts with company or email matching "Acme".
- Autocomplete ranks frequently emailed contacts higher.

---

### Phase 3 — CardDAV Sync Backend

**Goal:** Add provider-agnostic contact sync.

1. **Schema preparation**
   - Ensure `contact_sync_state` table has columns: `account_id`, `contact_id`, `external_id`, `href`, `etag`, `raw_vcard`, `last_synced_at`, `source`.
   - Add unique index `(account_id, external_id)` and `(account_id, href)`.

2. **Rust CardDAV client**
   - Implement in `kylins.client.backend/src/sync/contacts/carddav.rs`:
     - `discover_addressbooks(base_url, credentials)` — PROPFIND for `addressbook-home-set`.
     - `sync_addressbook(account_id, addressbook_url, sync_token?)` — `sync-collection` REPORT with sync-token; fallback to PROPFIND + `addressbook-multiget`.
     - `create_contact`, `update_contact`, `delete_contact` — PUT/DELETE with etag preconditions.
   - Use `reqwest` with Basic/Digest auth; OAuth2 deferred.
   - Parse fetched VCF via existing `vcard.rs`; upsert into `contacts` + `contact_sync_state`.

3. **Multi-source merge logic**
   - On CardDAV upsert, normalize email and check for existing contact.
   - If existing contact exists, merge by deterministic priority (`manual` > `carddav:<account>` > `inferred`).
   - Store each source's `raw_vcard` separately in `contact_sync_state`.
   - When deleting from one source, only delete the `contact_sync_state` row; only delete the global `contacts` row when no sources remain.

4. **Sync scheduler**
   - Add `sync_contacts_account(account_id)` Tauri command.
   - Run every 30 minutes via Tokio background task (reuse mail scheduler pattern).
   - Queue local changes when offline; apply on next sync.

5. **Frontend account settings**
   - Add "Contacts" section in account settings to enable/disable CardDAV sync and enter server URL/credentials.
   - Add "Sync now" button.

6. **Tests**
   - Mock CardDAV server in Rust tests (`tests/sync_contacts_carddav.rs`) using `wiremock` or `httpmock`.
   - Test sync-token delta, etag conflict, fallback multiget, and merge semantics.

**Verification:**
- Connect to Nextcloud CardDAV → contacts sync down.
- Edit a contact in Kylins → change PUTs to server.
- Delete a contact on server → deletion syncs down.
- Same email in two CardDAV accounts → one merged contact with two sync-state rows.

---

### Phase 4 — Deferred

- **Google People sync:** OAuth2 scope, People API mapping, group mapping.
- **EAS GAL / contact sync:** Requires EAS Rust backend completion.
- **LDAP directory lookup:** Read-only search for enterprise deployments.
- **vCard/CSV import/export UI:** Wire existing `parse_vcard` / `export_vcard` commands into `ContactsPreferences.tsx` and Contacts page.
- **Contact group expansion in composer:** Type a group name → expand to all member emails.

---

## Cross-Cutting: Multi-Source Merge Semantics

When CardDAV sync lands, a single email may appear in multiple sources. Define these rules explicitly:

1. **Identity key:** normalized lower-case email address.
2. **Source priority:** `manual` > `carddav:<account_id>` (first configured wins) > `inferred`.
3. **Field winner:** For each mutable field (`display_name`, `company`, `job_title`, etc.), the highest-priority source wins.
4. **Raw preservation:** Each source's raw vCard is stored in `contact_sync_state.raw_vcard` so unknown properties survive round-trips.
5. **Deletion:** Deleting a source's sync-state row only removes that source's contribution. The global contact is deleted only when no manual/carddav sources remain. Inferred-only contacts may be auto-deleted if their frequency drops to zero.
6. **Conflict UI:** If two CardDAV sources disagree on a field, show the source provenance in ContactDetail and allow the user to pick the preferred value, promoting the contact to `manual`.

---

## Critical Files to Create / Modify

### Frontend

| Path | Action | Purpose |
|------|--------|---------|
| `src/features/viewer/ContactSidebar.tsx` | Create | Reading-pane contact card |
| `src/services/contacts/avatar.ts` | Create | Gravatar fetch + local cache |
| `src/services/contacts/seedFromMail.ts` | Create | Incoming-mail contact seeding |
| `src/services/db/contactsCommands.ts` | Create | Rust db_* command wrapper |
| `src/components/layout/ReadingPane.tsx` | Modify | Contact enrichment + sidebar toggle |
| `src/components/mail/MessageList.tsx` | Modify | Batch sender enrichment |
| `src/components/composer/FromSelector.tsx` | Modify | Account contact avatar |
| `src/features/composer/RecipientField.tsx` | Modify | FTS autocomplete |
| `src/components/contacts/ContactDetail.tsx` | Modify | Promote inferred → manual, source provenance |
| `src/components/contacts/ContactsPreferences.tsx` | Modify | Wire vCard import/export, avatar opt-in |
| `src/stores/contactStore.ts` | Modify | Batch add/update/remove, group cache |
| `src/stores/uiStore.ts` | Modify | Persist `contactSidebarVisible` |
| `src/services/db/contacts.ts` | Modify | Use command wrapper |

### Backend

| Path | Action | Purpose |
|------|--------|---------|
| `kylins.client.backend/src/db/contacts.rs` | Create | Rust DB commands for contacts/groups |
| `kylins.client.backend/src/sync/contacts/carddav.rs` | Create | CardDAV client |
| `kylins.client.backend/src/sync/contacts/scheduler.rs` | Create | Background contact sync poll |
| `kylins.client.backend/src/commands.rs` | Modify | Register db_* and sync commands |
| `kylins.client.backend/migrations/` | Add | Index, FTS table/triggers, sync-state tweaks |
| `kylins.client.backend/tests/sync_contacts_carddav.rs` | Create | Mock CardDAV tests |

---

## Verification Gates

Per project memory, run from `kylins.client.frontend/`:

```bash
npx tsc --noEmit && npx eslint . && npx prettier --check . && npx vitest run
```

### Phase 0
- Batch contact command returns all matching emails in one call.
- Message list rendering stays fast with 1000 rows.

### Phase 1a
- ReadingPane shows avatar + company for known sender.
- MessageList uses contact display names.
- Contact sidebar toggles and shows recent threads.

### Phase 1b
- Outgoing mail still creates `manual` contacts.
- Repeated inbound human sender creates `inferred` contact.
- System addresses do not create contacts.

### Phase 1c
- Gravatar opt-in controls network requests.
- Avatar renders from local cache offline.

### Phase 2
- All contacts CRUD works through Rust commands.
- FTS search returns ranked matches.
- Autocomplete ranks frequent contacts higher.

### Phase 3
- CardDAV sync down/up/delete round-trips correctly.
- Multi-source merge handles duplicate emails across accounts.
- Mock server tests pass.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| N+1 contact queries slow message list | Phase 0 batch command + index before any enrichment. |
| Large initial sync creates contact spam | Confidence scoring + throttling + system-address blocklist. |
| Multi-source CardDAV merge conflicts | Explicit priority rules + source provenance UI + raw vCard preservation. |
| Rust DB command cutover breaks UI | Adapter layer preserves existing service API; integration tests. |
| Gravatar privacy leak | Per-account opt-in + local cache. |
| CardDAV server quirks (no sync-token) | Fallback to PROPFIND + multiget. |
| FTS5 unavailable in some builds | SQLite bundled with Tauri supports FTS5; verify in CI. |

---

## Conclusion

Kylins Client's contacts subsystem is already closer to a mature desktop address book than the composer/viewer/calendar subsystems were. The highest-leverage work is not a schema rewrite but **making the existing rich data visible and useful**: enrichment in the reading pane and message list, a reading-pane contact sidebar, and intelligent incoming-mail seeding. After that, **Rust DB command parity + FTS** aligns the data layer with the rest of the app, and **CardDAV sync** turns the local address book into a first-class citizen of the user's cloud accounts.

Defer Google People, EAS GAL, LDAP, and group expansion in composer until the core local + CardDAV experience is solid.
