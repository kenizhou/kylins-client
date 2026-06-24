# Frontend Design & Implementation Plan — Composer, Viewer, Calendar

**Date:** 2026-06-23
**Scope:** The three user-facing frontend components of Kylins Client (mail composer, mail viewer, calendar), built on the existing Tauri 2 / React 19 / TypeScript / Zustand / Tailwind v4 / SQLite stack.
**Source strategy:** **velo is the architecture owner; Mailspring is the feature donor.** When both implement a feature, velo's implementation is kept and Mailspring's is not ported. Mailspring features that velo lacks are ported *into* velo's patterns (store names, plugin API, provider abstraction, DB schema, file layout, theming) — never the reverse. The quoted-reply **collapse** feature is excluded.

---

## 1. Principles

1. **velo-first.** The skeleton, stores, provider abstraction, DB schema, theming, and plugin manager all come from velo. We do not introduce a competing architecture.
2. **Seamless ports.** A Mailspring feature lands behind a velo-shaped seam: e.g. Mailspring's `ical.js` layer is exposed through velo's existing `icalHelper.ts` interface; Mailspring's RSVP card is registered through Kylins' plugin slot system; Mailspring's find-in-thread is added *into* velo's `EmailRenderer`.
3. **No gratuitous swaps.** If velo has working code, we enhance it rather than replace it. (This reverses the earlier tentative FullCalendar idea — see §6.3.)
4. **Editor engine = TipTap v3 / ProseMirror** (velo's choice). Mailspring's Slate 0.50 plugins are re-authored as TipTap extensions; the *feature set and HTML serialization rules* are borrowed, not the Slate code.
5. **C++ mailsync is irrelevant.** Mailspring's sync runs in an unavailable C++ binary. All transport is reimplemented in Kylins' existing Rust backend / TS providers. We borrow *JS logic*, never the sync engine.
6. **Collapse excluded.** `quoted-html-transformer` / `ConditionalQuotedTextControl` / composer `quoted-text-control` and the `thread-sharing` dependency on them are out of scope. (velo has no quoted-reply collapse either, so this is a no-op.) Thread-message minification is kept (it is a different feature); flag if you also want that dropped.

---

## 2. Architecture baseline

### 2.1 What Kylins already has (skeleton)
- `kylins.client.frontend/src/services/` — `db/{connection,migrations,accounts,settings}`, `crypto`, `plugins/{pluginManager,pluginAPI}`, `queue/offlineQueue`, `ai/{aiService,providers/*}`, `mail/{provider,easProvider}` (stub), `theme/themeManager`.
- `src/stores/` — `uiStore`, `accountStore`.
- `src/components/layout/AppShell.tsx` — three-pane shell, `HeaderBar`, `CommandRibbon`, `ToolWindowBar`, `StatusBar.
- `src/components/email/SafeHtmlFrame.tsx` — current viewer scaffold (sandboxed iframe + DOMPurify).
- Plugin system: `pluginManager` with `registerComponent(role, Comp)`, `onEvent`, `registerAction`; `InjectedComponent{,Set}` slot rendering on `__registry_changed__`.

### 2.2 What velo contributes (port verbatim, then enhance)
- **Composer:** `Composer.tsx`, `EditorToolbar.tsx`, `AddressInput.tsx`, `FromSelector.tsx`, `SignatureSelector.tsx`, `TemplatePicker.tsx`, `AiAssistPanel.tsx`, `AttachmentPicker.tsx`, `ScheduleSendDialog.tsx`, `UndoSendToast.tsx`; `stores/composerStore.ts`; `services/composer/draftAutoSave.ts`; `utils/{emailBuilder,sanitize,mailtoParser,templateVariables}.ts`; `ComposerWindow.tsx`.
- **Viewer:** `components/email/{EmailRenderer,MessageItem,ThreadView,AttachmentList,InlineAttachmentPreview,ContactSidebar,PhishingBanner,RawMessageModal,LinkConfirmDialog,ActionBar}.tsx`; `utils/{sanitize,imageBlocker,phishingDetector}.ts`; `services/{unsubscribe,phishing,attachments,contacts}/*`; `services/db/{imageAllowlist,contacts,phishingAllowlist,linkScanResults}.ts`.
- **Calendar:** `services/calendar/{types,providerFactory,googleCalendarProvider,caldavProvider,autoDiscovery,icalHelper}.ts`; `components/calendar/*`; `services/db/{calendarEvents,calendars}.ts`; migrations for `calendar_events`/`calendars` (velo v19, incl. `ical_data`/`etag`/`uid`).
- **Cross-cutting:** Zustand stores, Tailwind v4 + `oklch()` CSS-var theming, `@/` alias, Tauri SQL lazy singleton + `withTransaction`.

### 2.3 What Mailspring contributes (port into velo seams)
- **Composer:** emoji data + `:name:` node; plaintext mode (`plaintext.ts`); font/size/color TipTap marks; image-resize NodeView; `juice` inline-CSS on send; paste-pipeline `parseHtml` pre-step; grammar-check (LanguageTool) as optional.
- **Viewer:** `@import`-strip DOMPurify hook + URI-scheme allowlist regex; tracker-pixel blacklist (~26 services) + 1×1 rule; from-domain≠reply-to-domain heuristic; find-in-thread (`iframe-searcher`); iframe right-click context menu; message-clipped (>300k) handling.
- **Calendar (largest donation):** `calendar-utils.ts` + `ics-event-helpers.ts` (~993 LOC + 711-LOC test) + `event-rsvp-task.ts`; `occurrencesForEvents` recurrence expansion; `recurring-event-actions.ts` + dialog; `calendar-helpers.tsx` color system + `createCalendarEvent`; view math (`week-view-helpers.ts` overlap packing, `calendar-drag-utils.ts`); `event-header.tsx` RSVP card + `.ics` detection + `HideICSAttachmentExtension`; `windows-iana`; event-edit popover selectors; undo/redo store; event search.
- **Cross-cutting (optional contracts):** `ComposerExtension` and `MessageViewExtension` hook shapes, adapted to Kylins' `pluginManager`.

### 2.4 Coupling-replacement map (Mailspring → Kylins)
| Mailspring | Kylins replacement |
|---|---|
| `@electron/remote` Menu/MenuItem | `@tauri-apps/api/menu` |
| BrowserWindow | `@tauri-apps/api/webviewWindow` |
| clipboard | `@tauri-apps/plugin-clipboard-manager` |
| `shell.openExternal` | `@tauri-apps/plugin-opener` |
| `fs` / temp dir | Rust `std::fs` + `tauri::path` |
| Reflux stores / `Actions.*` | Zustand stores + event bus |
| `mailspring-exports` | direct `@/` imports |
| `mailspring-component-kit` | Radix/shadcn + existing components |
| `rx-lite` | Zustand / observables |
| `DatabaseStore`/`Matcher` | `getDb()` + small reactive query layer |
| C++ mailsync (SMTP/IMAP/CalDAV) | Kylins Rust backend + TS providers |
| `juice` (main process) | Web Worker or Rust command |

---

## 3. Target frontend layout (`kylins.client.frontend/src/`)

```
src/
  components/
    composer/
      Composer.tsx                 (velo)
      EditorToolbar.tsx            (velo, +font/size/color buttons)
      AddressInput.tsx             (velo, +ReplyTo)
      FromSelector.tsx             (velo)
      SignatureSelector.tsx        (velo)
      TemplatePicker.tsx           (velo)
      AiAssistPanel.tsx            (velo, +translate action)
      AttachmentPicker.tsx         (velo)
      ScheduleSendDialog.tsx       (velo)
      UndoSendToast.tsx            (velo)
      EmojiPicker.tsx              (Mailspring)
      plaintext.ts                 (Mailspring, verbatim util)
    email/
      EmailRenderer.tsx            (velo, +find-in-thread, +iframe ctx menu, +clip)
      MessageItem.tsx, ThreadView.tsx, AttachmentList.tsx,
      InlineAttachmentPreview.tsx, ContactSidebar.tsx,
      PhishingBanner.tsx, RawMessageModal.tsx, LinkConfirmDialog.tsx,
      ActionBar.tsx                (velo)
      FindInThread.tsx             (Mailspring)
      EventInviteCard.tsx          (Mailspring event-header → RSVP)
    calendar/
      CalendarPage.tsx             (velo, +multi-account, +recurrence feed)
      CalendarToolbar.tsx          (velo, +agenda)
      MonthView.tsx, WeekView.tsx, DayView.tsx   (velo, +overlap packing, +drag/resize)
      AgendaView.tsx               (new, Mailspring pattern)
      EventCard.tsx                (velo)
      EventCreateModal.tsx, EventDetailModal.tsx (velo, +attendees/tz/alerts/recurrence)
      CalendarList.tsx, CalendarReauthBanner.tsx (velo)
      EventEditPopover.tsx + selectors (Mailspring, anchored to click)
    ui/  (shared primitives — Radix/shadcn)
  services/
    composer/
      draftAutoSave.ts             (velo)
      juiceInline.ts               (new — CSS→inline for send)
    mail/
      easProvider.ts, imapSmtpProvider.ts, gmailProvider.ts, providerFactory.ts, types.ts  (velo)
    calendar/
      icalHelper.ts                (SEAM — interface; impl swaps to ical.js)
      icalJsParser.ts              (Mailspring calendar-utils + ics-event-helpers)
      recurrenceExpander.ts        (Mailspring occurrencesForEvents)
      rsvpTask.ts                  (Mailspring event-rsvp-task)
      recurringActions.ts          (Mailspring recurring-event-actions)
      calendarHelpers.ts           (Mailspring colors + createCalendarEvent)
      easCalendarProvider.ts       (new — from mailkit MS-ASCAL spec)
      googleCalendarProvider.ts, caldavProvider.ts, autoDiscovery.ts,
      providerFactory.ts, types.ts (velo)
    email/
      sanitize.ts                  (velo + Mailspring @import/URI hardening)
      imageBlocker.ts              (velo + Mailspring tracker blacklist + 1×1)
      phishingDetector.ts          (velo + Mailspring from/reply-to heuristic)
      trackerBlacklist.ts          (Mailspring, verbatim data)
      findInThread.ts              (Mailspring iframe-searcher)
      unsubscribeManager.ts        (velo)
    plugins/
      pluginManager.ts             (Kylins, +extension contracts)
      pluginAPI.ts                 (Kylins, +registerComposerExtension/registerMessageViewExtension)
    db/
      migrations.ts                (+message_metadata, +recurrence cols, verify v19 calendar)
      contacts.ts, imageAllowlist.ts, calendars.ts, calendarEvents.ts (velo)
  stores/
    composerStore.ts, threadStore.ts, uiStore.ts, accountStore.ts,
    contextMenuStore.ts, calendarStore.ts (new — extract from velo CalendarPage useState)
  utils/
    emailBuilder.ts, sanitize.ts(symlink/merge), mailtoParser.ts,
    templateVariables.ts, regexp.ts (Mailspring), subject.ts (Mailspring)
```

---

## 4. Component 1 — Composer

### 4.1 Design
- **Engine:** TipTap v3 (`@tiptap/react` `^3.19.0`, StarterKit, Placeholder, Image `inline+allowBase64`, Underline, TextStyle, Color, Link). Custom marks/nodes authored from Mailspring's Slate plugins (see §4.3).
- **State:** velo's `composerStore` (Zustand) is the single source of truth. Mailspring's `draft-change-set` batching is *not* ported — velo's 3s debounced `draftAutoSave` subscriber is kept (faster, already batching on dirty fields).
- **Send path:** velo's `emailBuilder.ts` (pure-TS MIME) is kept. A new `juiceInline.ts` step is inserted before MIME building to inline CSS for email-client fidelity (the one gap velo+Mailspring both leave open on the JS side; Mailspring's `inline-style-transformer` proves the approach).
- **Paste:** add an explicit TipTap `handlePaste` that runs DOMPurify (velo `sanitize.ts`, hardened) + Mailspring's `parseHtml` pre-step + `juiceInline` before ProseMirror ingests. This is where Word/Excel paste gets tamed.
- **Extensions:** optional `ComposerExtension` contract (`sendActions`, `warningsForSending`, `applyTransformsForSending`) added to `pluginAPI` so future send-time features (tracking, translation) plug in without touching the core.

### 4.2 Keep from velo (do not re-port from Mailspring)
Toolbar, AddressInput + frequency-ranked contacts autocomplete, FromSelector, per-account signatures, templates with 8 `{{var}}` + shortcut expansion, 3s draft autosave, inline CID images, MIME builder, pop-out window, mailto, quoted reply/forward, schedule-send, configurable undo-send, send-and-archive, follow-up reminders, AI assist.

### 4.3 Port from Mailspring (as TipTap extensions / velo enhancements)
| Feature | TipTap/velo landing |
|---|---|
| Emoji `:name:` + grid | custom atom Node + Suggestion; `EmojiPicker.tsx` |
| Plaintext mode | `plaintext.ts` util + a textarea mode toggle in `composerStore.viewMode` |
| Font family / size / color / highlight | custom Marks; buttons added to `EditorToolbar.tsx` |
| Image resize handles | NodeView on the Image node |
| `juice` inline-CSS on send | `services/composer/juiceInline.ts` in the send pipeline |
| Cmd+K link modal | keymap extension → existing `InputDialog` |
| Paste sanitization hardening | `handlePaste` extension + hardened `sanitize.ts` |
| Translation | new AI-assist transform (not a Mailspring port) |

### 4.4 Slate→TipTap plugin mapping (borrow feature+serialization, rewrite code)
`base-mark` → StarterKit + custom font/size/color marks; `base-block` → StarterKit (+RTL); `link` → `@tiptap/extension-link` + email-autolink InputRule; `markdown` → StarterKit InputRules; `template` → velo already has; `emoji` → custom Node+Suggestion; `inline-attachment` → custom atom Node+NodeView; `uneditable` → custom block atom Node+NodeView; `grammar` → ProseMirror Decoration plugin (optional). **Delete** `patch-chrome-ime.ts` (TipTap handles IME).

---

## 5. Component 2 — Viewer

### 5.1 Design
- **Container:** velo's `EmailRenderer.tsx` — `<iframe sandbox="allow-same-origin">` (no `allow-scripts`) + `document.write` + `ResizeObserver` auto-height. This already enables the parent-DOM access that Mailspring's find-in-thread and context-menu need (no sandbox decision to make — velo chose correctly).
- **Sanitize:** keep velo's `sanitize.ts` config; harden with Mailspring's `uponSanitizeElement` `@import`-strip hook (via `CSSStyleSheet.replaceSync`) and an explicit URI-scheme allowlist regex.
- **Remote images:** keep velo's `imageBlocker.ts` + `imageAllowlist.ts` (per-sender) + banner. Add Mailspring's tracker-URL blacklist + 1×1/0×0 detection into `imageBlocker`.
- **Phishing:** keep velo's 10-heuristic `phishingDetector.ts` (richer than Mailspring). Add the from-domain≠reply-to-domain rule. **Wire the orphaned `LinkConfirmDialog`** into `EmailRenderer.handleClick` so link clicks are gated by a phishing pre-check (velo has the dialog but never wired it).
- **Extension hook:** add optional `MessageViewExtension` (`formatMessageBody`, `renderedMessageBodyIntoDocument`, `filterMessageFiles`) to `pluginAPI` — powers tracker-strip, ICS-hide, future body mutations without forking `EmailRenderer`.

### 5.2 Keep from velo
Sandboxed iframe + DOMPurify, remote-image block + per-sender allowlist + banner, phishing banner (10 heuristics), three-tier unsubscribe, AttachmentList + image/PDF preview + disk cache, ContactSidebar + contacts DB, auto-height, plaintext rendering, light-card dark mode, thread stacking (older collapsed by default), print thread, view-source (`RawMessageModal`).

### 5.3 Port from Mailspring (into velo seams)
- `@import`/URI sanitize hardening → `sanitize.ts`.
- Tracker blacklist + 1×1 → `imageBlocker.ts` + `trackerBlacklist.ts`.
- From/reply-to heuristic → `phishingDetector.ts`.
- Find-in-thread → new `FindInThread.tsx` + `iframe-searcher` logic inside `EmailRenderer`.
- Iframe right-click menu → `contextmenu` listener → Tauri `Menu`.
- Message-clipped (>300k) + "show all" → `EmailRenderer` + Tauri `WebviewWindow`.
- Wire `LinkConfirmDialog` to gate `openUrl`.

---

## 6. Component 3 — Calendar

### 6.1 The seam: `icalHelper.ts` interface
velo's `icalHelper.ts` is hand-rolled (~200 lines, no RRULE/VTIMEZONE/METHOD/EXDATE). Rather than fork callers, **define `icalHelper.ts` as an interface** and swap the implementation to Mailspring's `ical.js`-based layer (`icalJsParser.ts` = `calendar-utils.ts` + `ics-event-helpers.ts`). All velo callers (providers, views, modals) keep calling `icalHelper`; the capability silently becomes complete. This is the canonical "seamless port."

Interface (target):
```ts
parseEvent(ics: string): ParsedEvent[]          // VEVENT, incl. METHOD, attendees, RRULE, tzid
generateICS(event): string                       // RFC 5545 with VTIMEZONE
expandOccurrences(events, range): Occurrence[]   // ical-expander; RRULE/EXDATE/RDATE
createRecurrenceException(master, recurId, patch): string
updateEventTimes / updateRecurrenceRule / addExclusionDate / updateAttendees
```

### 6.2 Design
- **State:** extract a new `calendarStore.ts` (Zustand) from velo's `CalendarPage` `useState` (currentDate, view, events, calendars, loading). Enables multi-account aggregation later.
- **Data flow:** provider → `calendarEvents` DB (already stores `ical_data`) → `recurrenceExpander` (ical-expander, per visible range) → views.
- **RSVP:** Mailspring `event-header.tsx` → `EventInviteCard.tsx`, registered at plugin slot `message:bodyHeader`. On Accept/Tentative/Decline → `rsvpTask.ts` builds RFC 5546 single-attendee REPLY → sent via the mail provider (EAS `SendMail` w/ `text/calendar` part, or SMTP). EAS accounts additionally fire `MeetingResponse` (mailkit spec).
- **Writes:** velo's create/update/delete go straight to provider (no recurrence). Enhance via Mailspring's `recurringActions.ts` (this-occurrence / all-occurrences; "this-and-following" built new) + `ics-event-helpers` for exception upserts.

### 6.3 Views: enhance velo, do NOT swap to FullCalendar (decision)
velo already has month/week/day views in velo's style. Per the velo-first principle, **enhance them** rather than introduce FullCalendar:
- Overlap-packing: port Mailspring's `overlapForEvents` sweep-line into `WeekView`/`DayView` (replaces simple hour-bucketing).
- Drag/resize: port Mailspring's `calendar-drag-utils` `DragState` math; on drop → `recurringActions`.
- Agenda view: new `AgendaView.tsx` (Mailspring `agenda-view` pattern).
- Recurrence display: views consume `expandOccurrences` output (many chips from one master).

**Fallback (documented only):** if velo's enhanced views prove inadequate (e.g. need resource/timeline scheduling), swap to FullCalendar Standard (MIT) at that point — FullCalendar's event-source model maps cleanly to the `expandOccurrences` output, so the data layer is unaffected. This keeps the FullCalendar option open without committing to it now.

### 6.4 Keep from velo
`CalendarProvider` abstraction, Google REST v3 provider (incremental syncToken), CalDAV provider (`tsdav`), autoDiscovery (RFC 6764), DB schema, calendar list + colors, month/week/day views, basic event CRUD, modals.

### 6.5 Port from Mailspring
`ical.js` parse/mutate layer (behind `icalHelper` seam), `occurrencesForEvents` recurrence expansion, RSVP card + REPLY task, `recurringActions` + dialog, `calendarHelpers` (colors + `createCalendarEvent` + `extractMeetingDomain`), view overlap/drag math, event-edit popover selectors (attendees/timezone/alerts/show-as/repeat), undo/redo store, event search, `windows-iana`.

### 6.6 Build new (absent in both)
- `easCalendarProvider.ts` — EAS calendar sync (Sync w/ `Calendar` class) + `MeetingResponse` command, from mailkit's MS-ASCAL ArkTS models as spec.
- VALARM local notifications → `tauri-plugin-notification`.
- Compose-side "send invite" (author `METHOD:REQUEST` via `icalHelper.generateICS`, attach in composer).
- Free/busy / "find a time" (later).
- Multi-account aggregation in `calendarStore`.

---

## 7. Cross-cutting

### 7.1 Plugin extension contracts
Extend `pluginAPI` with `registerComposerExtension(ext)` and `registerMessageViewExtension(ext)` (priority-sorted registries in `pluginManager`). These are *optional* hooks; existing `registerComponent(role, Comp)` stays primary. This unlocks tracker-strip, ICS-hide, send-time transforms, etc. as self-contained extensions without forking core components.

### 7.2 Theming
velo's Tailwind v4 + `oklch()` CSS-var theme (`theme.css`) is the system. Mailspring LESS → Tailwind/CSS-vars. Email iframe theming stays velo's static-style-block approach (light-card for HTML, dark-flip for plaintext) — do NOT adopt Mailspring's `invert(1)` filter.

### 7.3 DB migrations (add to `services/db/migrations.ts`, never edit applied ones)
- `message_metadata(message_id, plugin_id, value_json)` — for RSVP state, tracking, etc. (Mailspring `syncback-metadata` pattern).
- Verify/adopt velo v19 calendar columns (`calendar_events.ical_data/etag/uid`, `calendars.sync_token/ctag`).
- Add `calendar_events.recurrence_start`/`recurrence_end` (Mailspring pattern) for fast range queries without expanding ICS.
- `events_fts` (FTS5) for event search (mirror existing `messages_fts`).

### 7.4 Dependencies to add (`kylins.client.frontend/package.json`)
```
@tiptap/react @tiptap/starter-kit @tiptap/extension-placeholder @tiptap/extension-image
@tiptap/extension-underline @tiptap/extension-text-style @tiptap/extension-color @tiptap/extension-link @tiptap/pm
ical.js ical-expander windows-iana            # calendar data layer
juice                                          # CSS→inline on send (or Rust equiv)
tldts                                          # phishing domain comparison (replaces Mailspring's `tld`)
downshift / @ariakit/react                     # tokenizing inputs, menus
luxon OR moment-timezone                       # keep moment-timezone if porting ical-helpers verbatim (VTIMEZONE gen)
chrono-node                                    # natural-language dates (quick-event)
```
Drop: none of velo's. (FullCalendar intentionally NOT added unless §6.3 fallback triggers.)

---

## 8. Phased implementation roadmap

> Phases are independent per component where noted. Each phase is independently shippable.

**Phase 0 — Foundations (no UI; unblocks all)**
- Add deps (§7.4).
- Extend `pluginManager`/`pluginAPI` with the two extension contracts (§7.1).
- DB migrations (§7.3).
- Define the `icalHelper.ts` interface seam (§6.1); keep velo's current parser as the v1 impl behind it.

**Phase 1 — Composer (mostly adopt-velo + 2 enhancements)**
- Port velo composer verbatim (all files in §2.2 + `composerStore`).
- Harden `sanitize.ts` (@import + URI allowlist).
- Add `juiceInline.ts` to the send pipeline.
- Add Cmd+K.
- *Deliverable:* working Outlook-style composer, email-safe HTML on send.

**Phase 2 — Viewer (adopt-velo + MS hardening)**
- Port velo viewer verbatim (EmailRenderer, imageBlocker, allowlist, AttachmentList, ContactSidebar, PhishingBanner, unsubscribe, ThreadView, MessageItem, RawMessageModal).
- Tracker blacklist + 1×1 into `imageBlocker`; from/reply-to heuristic into `phishingDetector`; wire `LinkConfirmDialog`.
- Add find-in-thread + iframe context menu + message-clipped.
- *Deliverable:* hardened, privacy-first reading pane.

**Phase 3 — Calendar data core (the big Mailspring port)**
- Swap `icalHelper` impl to `ical.js` layer; port `ics-event-helpers` + 711-LOC tests.
- Port `recurrenceExpander`; feed views expanded occurrences.
- Extract `calendarStore`.
- *Deliverable:* recurring/timezoned events parse + display correctly.

**Phase 4 — Calendar UX + meeting workflow**
- Enhance views (overlap-packing, drag/resize, agenda).
- RSVP card in mail viewer + `rsvpTask` (REPLY); EAS `MeetingResponse`.
- `recurringActions` + dialog; enhance edit modal (attendees/tz/alerts/show-as/recurrence).
- Undo/redo + event search + keymaps.
- *Deliverable:* full meeting-invite lifecycle.

**Phase 5 — Sync + greenfield**
- `easCalendarProvider` (mailkit spec) + EAS calendar sync.
- VALARM notifications; compose-side send-invite.
- Multi-account aggregation.
- Free/busy (later).

**Phase 6 — Composer/viewer polish**
- Emoji, plaintext mode, font/size/color marks, image resize (composer).
- Per-message zoom (viewer).
- Grammar check (optional, LanguageTool).

---

## 9. Open decisions (confirm before Phase 1)

1. **Calendar views** — enhance velo (recommend) vs swap to FullCalendar now? (§6.3)
2. **License posture** — Kylins open/GPL-compatible (→ vendor Mailspring verbatim where indicated) vs possibly closed-source (→ reimplement those from pattern)? Affects Phase 3/4 verbatim copies.
3. **Outbound link/open tracking** — port from Mailspring (read receipts) or keep velo's privacy stance (block inbound trackers only)? Recommend: keep velo's stance; make tracking opt-in later.
4. **Date library** — keep `moment-timezone` (verbatim ical-helper port) or migrate to `luxon` (more work, smaller bundle)?

---

## 10. Risk register
- **ical.js + ical-expander bundle size** — acceptable for a desktop app; monitor.
- **EAS calendar sync scope** — mailkit gives a spec, not code; Phase 5 is the largest greenfield risk. De-risk by shipping CalDAV/Google first (velo-ready).
- **juice on send** — `juice` is Node-oriented; run in a Web Worker or a Rust command to avoid main-thread jank on large pastes.
- **Plugin extension contracts** — adding hooks to `pluginManager` must not regress the existing `__registry_changed__` slot rendering; cover with tests.
- **Viewer sandbox** — velo's `allow-same-origin` + no-`allow-scripts` + DOMPurify is the correct, industry-standard config; keep it. Do not regress to pure `sandbox=""` (the current Kylins `SafeHtmlFrame` scaffold) or we lose find-in-thread/context-menu.
