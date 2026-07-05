# Kylins Client — Composer & Viewer Enhancement Plan

## Context

Kylins Client already has a working modal composer (`Composer.tsx`) and an inline reply/forward composer (`InlineReply.tsx`), plus a basic reading pane (`ReadingPane.tsx`). The goal is to raise the compose and read experience to the level of mature clients by studying **Thunderbird Desktop** and **Mailspring**:

- **Composer**: how to expose Cc/Bcc/Reply-To cleanly, show send progress/status, and organize the original body when replying or forwarding.
- **Viewer**: how to present sender/recipients/subject/time and action menus, and how to surface meeting requests / calendar events for RSVP.

Reference findings confirm Kylins is on the right architectural track (TipTap editor, file-backed attachments, `buildSendDraft` MIME builder, plugin-injected reading-pane slots). The enhancements below are therefore **incremental polish and wiring**, not a rewrite.

## Decisions

1. **Keep the existing compose pipeline** (`send.ts` → `buildSendDraft` → Rust `sync_apply_mutation`). It already mirrors Mailspring’s `DraftStore`/`DraftFactory` split and Velo’s builder.
2. **Reply-To is a first-class header field** in both modal and inline composers, toggled together with Cc/Bcc.
3. **Send status lives in the composer UI** (`sending…` / `Queued` / `Sent` / error) rather than only in a background toast, because Thunderbird/Mailspring both expose this directly on the Send button.
4. **Reply/forward quoting reuses `prepareBodyForQuoting.ts`**; the improvements are preserving inline images and re-attaching original files when forwarding.
5. **Viewer chrome stays outside the sandboxed iframe** for accessibility; the iframe continues to contain only sanitized body HTML.
6. **Meeting-request handling is viewer-native**: detect `text/calendar; method=REQUEST` attachments, parse with `icalHelper`, render an `RsvpCard`, and send the iMIP REPLY through the existing send pipeline.

## Architecture & Data Flow

```
Composer UI ──► composerStore ──► send.ts / buildSendDraft ──► sync_apply_mutation ──► Rust send worker
     │                │
     └─ draftAutoSave ─┘

ReadingPane ──► message + attachments ──► EmailRenderer (sandboxed iframe)
     │
     ├─ plugin slots: reading-pane:actions / reading-pane:footer
     └─ text/calendar attachment ──► icalHelper ──► RsvpCard ──► rsvpTask ──► send.ts
```

## Implementation Phases

### Phase 1 — Composer header (Cc/Bcc/Reply-To)

1. **Modal composer** (`src/components/composer/Composer.tsx`)
   - Add a `Reply-To` `RecipientField` row shown when `showCcBcc` is true.
   - Add a "Reply-To" move target on To/Cc/Bcc fields so a recipient can be shifted there.
   - Persist `replyTo` in `composerStore` and pass it through `openComposer` / pop-out params.

2. **Inline composer** (`src/components/email/InlineReply.tsx`)
   - Add local `replyToRecipients` state and a Reply-To row inside the Cc/Bcc block.
   - Forward `replyTo` to `sendEmail`.

3. **Store** (`src/stores/composerStore.ts`)
   - Add `replyTo: Recipient[]` and `setReplyTo` (already partially present — wire UI).
   - Add optional `sendStatus`/`sendError` fields only if the modal needs to show post-close status; prefer local component state for simplicity.

4. **Send payload** (`src/services/composer/send.ts`, `buildSendDraft.ts`)
   - Extend `DraftInput` with `replyTo?: Recipient[]`.
   - Include a `Reply-To` RFC 5322 header in the MIME builder.

### Phase 2 — Send progress & status

1. **Modal composer**
   - Replace the static `Send` button with a stateful button:
     - `idle` → `Send`
     - `sending` → spinner + `Sending…`
     - `queued` → `Queued` (after undo window closes / send invoked)
     - `error` → inline error text + retryable `Send`
   - Keep the existing undo-send flow; the button label should reflect the real stage.

2. **Inline composer**
   - Show a compact send status pill next to the Send button.
   - Disable Discard while sending.

3. **Send orchestration**
   - `sendEmail` already returns `{ success, message }`. Surface `message` in the UI instead of logging only.
   - Dispatch an event (`composer:send-status-changed`) if a parent component needs to react.

### Phase 3 — Reply / forward body organization

1. **Quoting helper** (`src/features/composer/prepareBodyForQuoting.ts`)
   - Keep `buildReplyQuote` (attribution + `gmail_quote` blockquote) and `buildForwardQuote` ("Forwarded Message" header block).
   - Add an option to **preserve inline CID images** in the quoted body (currently stripped); forward flow will re-attach them as files so the recipient sees them.
   - Ensure plaintext messages are converted to styled `<pre>` for the editor.

2. **Forward re-attach original files**
   - In `InlineReply.tsx` for `mode === 'forward'`, seed original-message attachments from the DB `attachments` table (use existing `getAttachments` / `fetchAttachment` / `stageAttachmentBytes` pattern from `Composer.tsx`).
   - Add a small toggle "Include original attachments" (default on for forward).

3. **Reply signature placement**
   - Continue using `applySignatureAboveQuote` so signatures appear above the quoted original, matching Outlook/Mailspring.

### Phase 4 — Viewer header & actions

1. **Refactor `ReadingPane.tsx`**
   - Extract a `MessageHeader` component that shows:
     - Sender avatar + full name + email + "Add to contacts"
     - Expandable recipient block: `To`, `Cc`, `Bcc` (if available)
     - Subject + classification badge
     - Full timestamp with timezone
   - Add a `More actions` dropdown menu with:
     - Reply / Reply All / Forward
     - Archive, Delete, Junk/Spam
     - Mark unread, View raw message, Print
   - Move the existing icon buttons into the same toolbar (or keep them visible + collapse overflow into the menu).

2. **Wire archive/delete**
   - Route through a new `src/services/mail/actions.ts` dispatcher that calls the appropriate Rust command (`sync_apply_mutation` with `type: 'move'`/`'delete'` or direct `db_*` commands today).
   - Use `db_get_folder_by_role` to resolve Archive/Trash/Sent folders.

3. **Attachment list**
   - `AttachmentList.tsx` already exists; ensure it renders for the selected message and supports download/open.

### Phase 5 — Meeting requests & RSVP card

1. **Detect calendar invites**
   - In `ReadingPane.tsx`, inspect `message.attachments` for `mimeType` starting with `text/calendar`.
   - Fetch the attachment body (base64), decode, and parse with `IcalHelper.parseEvents`.
   - Match events whose `method === 'REQUEST'`.

2. **Render `RsvpCard`**
   - Create `src/features/viewer/RsvpCard.tsx`.
   - Show event title, time, organizer, attendees (optional), location, and **Accept / Tentative / Decline** buttons + optional comment.
   - Use `partstatToEasResponse` mapping for EAS later.

3. **Send the RSVP reply**
   - On user choice, call `buildRsvpReply` from `src/services/calendar/rsvpTask.ts`.
   - Send an email with the REPLY ICS attached (`text/calendar; method=REPLY`) via `sendEmail`.
   - For EAS accounts, also call `eas_meeting_response` (Rust command) once it exists; guard with a feature flag / try/catch so the UI works for IMAP in the meantime.

4. **Update local calendar**
   - Upsert the accepted event into `calendar_events` with the user's chosen `partstat`.

### Phase 6 — Verification & polish

1. Add/extend tests:
   - `tests/components/composer/Composer.test.tsx` — Reply-To presence, Cc/Bcc toggle, send button states.
   - `tests/components/email/InlineReply.test.tsx` — forward seeds attachments, reply quote structure.
   - `tests/components/layout/ReadingPane.test.tsx` — header renders, dropdown actions, RSVP card appears for calendar attachment.
   - `tests/services/calendar/rsvpTask.test.ts` — REPLY ICS shape.

2. Run verification:
   - Backend: `cargo check && cargo clippy --all-targets && cargo test`
   - Frontend: `npm run lint && npm run build && npm test`
   - Tauri dev smoke test: reply to a message, add Reply-To, forward with attachments, open a calendar invite and RSVP.

## Critical Files to Create / Modify

### Create

- `src/features/viewer/RsvpCard.tsx`
- `src/features/viewer/MessageHeader.tsx` (or inline refactor of `ReadingPane`)
- `src/services/mail/actions.ts` (provider-agnostic archive/delete/move dispatcher)
- `tests/components/composer/Composer.test.tsx`
- `tests/components/email/InlineReply.test.tsx`
- `tests/features/viewer/RsvpCard.test.tsx`

### Modify

- `src/components/composer/Composer.tsx`
- `src/components/email/InlineReply.tsx`
- `src/stores/composerStore.ts`
- `src/services/composer/send.ts`
- `src/services/composer/buildSendDraft.ts`
- `src/features/composer/prepareBodyForQuoting.ts`
- `src/components/layout/ReadingPane.tsx`
- `src/services/calendar/rsvpTask.ts`
- `src/services/calendar/icalHelper.ts` (if TZID or METHOD edge cases surface)

## Reusable Helpers

- `participantsForReply` / `participantsForReplyAll` (`src/features/composer/recipientsForReply.ts`) — already handles Reply-To for recipient pre-fill.
- `buildReplyQuote` / `buildForwardQuote` (`src/features/composer/prepareBodyForQuoting.ts`) — quoting logic to extend.
- `applySignatureAboveQuote` (`src/features/composer/signaturePlacement.ts`) — signature placement.
- `IcalHelper.parseEvents` / `generateICS` (`src/services/calendar/icalHelper.ts`) — ICS parse/build seam.
- `buildRsvpReply` (`src/services/calendar/rsvpTask.ts`) — RFC 5546 REPLY builder.
- `sendEmail` (`src/services/composer/send.ts`) — send pipeline.

## Verification Steps

1. Backend compile & test:
   ```bash
   cd kylins.client.backend
   cargo check
   cargo clippy --all-targets
   cargo test
   ```
2. Frontend typecheck, build, and test:
   ```bash
   cd kylins.client.frontend
   npm run lint
   npm run build
   npm test
   ```
3. Tauri dev smoke test:
   ```bash
   cd kylins.client.backend
   cargo tauri dev
   ```
   Verify:
   - Modal composer shows To / Cc / Bcc / Reply-To rows and toggle works.
   - Inline reply shows Cc/Bcc/Reply-To and send status changes to `Sending…` then `Queued`/`Sent`.
   - Forwarding a message re-attaches original files.
   - Reading pane shows sender, expandable recipients, full date, and action menu.
   - Archive / Delete moves the thread to the correct folder.
   - Opening a meeting-request email renders the RSVP card; Accept sends a reply ICS.

## Open Items

- Plain-text compose mode and send-and-archive are useful follow-ups but out of scope for this pass.
- EAS `eas_meeting_response` Rust command is not yet implemented; the RSVP path will work over SMTP/IMAP via iMIP REPLY and can be augmented when the command lands.
- Full raw-message viewer and print stylesheet are deferred.
