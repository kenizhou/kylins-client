# Kylins Client — Fix Composer Reply/Forward Issues

## Context

The modal composer opened from the message list / CommandRibbon / ReadRibbon is only seeded with metadata (`threadId`, `fromEmail`, raw `subject`, `inReplyToMessageId`, classification/security flags). As a result:

1. **Cc/Bcc/Reply-To** are toggled as one block and do not follow Thunderbird-style behavior.
2. **Original body and attachments are missing** — the quoted reply/forward body is never built, and `originalMessageId` is not passed, so attachment seeding is skipped.
3. **Signature lands at the bottom** because `applySignatureAboveQuote` has no `gmail_quote` block to anchor on.

The inline reply (`InlineReply.tsx`) already builds the quoted body, resolves recipients, and seeds forwarded attachments. This plan centralizes that logic so the modal path behaves the same way, and it aligns the header UX with Thunderbird Desktop conventions (single Cc/Bcc/Reply-To expander + always-show preference, signature above the quote).

## Reference source

The canonical reference for this work is the local Thunderbird Desktop source at:

```
D:\Projects\mailclient\opensource\thunderbird-desktop
```

Key areas to mirror/validate against:
- Compose addressing controls (Cc/Bcc/Reply-To disclosure and per-account always-visible setting).
- Reply/forward body preparation and quoting.
- Signature placement relative to quoted text.

## User decisions

- **Reply-To pre-fill:** manual only — no identity-level auto-fill.
- **Signature placement:** always above the quoted original for replies/forwards.
- **Cc/Bcc/Reply-To toggle:** single expander link + a global `alwaysShowCcBcc` preference.
- **Forward inline images:** preserve them as CID by substituting `cid:` refs with `data:` URLs in the quoted body before sending (the existing send pipeline converts `data:` URLs back to CID attachments).

## Recommended approach

### 1. Shared modal-composer seeding helper

Create `src/features/composer/buildComposerOpenOptions.ts` that turns a `MailMessage` + mode into a complete `ComposeWindowOptions` payload:

- Resolve `to`/`cc` via `participantsForReply` / `participantsForReplyAll`.
- Prefix subject with `Re:` / `Fwd:`.
- Build the editor body via `buildReplyQuote` / `buildForwardQuote`.
- Resolve smart `fromEmail` via `resolveFromForReply` + aliases.
- For **forward** (and “reply with attachments”), set `originalMessageId` and `includeOriginalAttachments: true`.
- For **forward as attachment**, set `forwardAsAttachment: true` plus the cached original metadata.
- For **forward inline images**, fetch inline Content-ID parts (`fetchInlineImages`), build a `cid → data: URL` map, and pass it to the quote builder so `cid:` refs are replaced instead of stripped.

The helper is async because it reads send-as aliases and, for forwards, inline image parts.

### 2. Use the helper from all modal entry points

Rewrite `src/utils/composerActions.ts`:

- Change helpers to accept `{ accountId, accountEmail, accountDisplayName }` (needed for alias lookup and self-exclusion).
- Replace the thin wrappers with calls to `buildComposerOpenOptions`.
- `openReplyComposerWithAttachments` and `openReplyAllComposerWithAttachments` pass `includeOriginalAttachments: true`.
- `openForwardComposerAsAttachment` passes `forwardAsAttachment: true`.
- `openComposerForThread` passes the account object through.

Update callers:

- `src/components/layout/ribbon/ReadRibbon.tsx` — pass the active account object instead of just `accountEmail`.
- `src/components/layout/MessageList.tsx` — pass the account object for the thread's account.

### 3. Expose `replyTo` on `MailMessage`

In `src/services/db/threads.ts`, extend `mapMessageToMailMessage` to parse the `reply_to` column into `replyTo: { name, address }[]`. `participantsForReply` / `participantsForReplyAll` already honor it.

### 4. Cc/Bcc/Reply-To toggle behavior

#### Preference

- Add `alwaysShowCcBcc: 'always_show_cc_bcc'` to `src/services/settingsKeys.ts`.
- Add it to `src/stores/preferencesStore.ts` (default `false`).
- Add a checkbox in `src/components/preferences/GeneralPreferences.tsx` under the Composing section.

#### Modal composer (`src/components/composer/Composer.tsx`)

- Read `alwaysShowCcBcc` from `usePreferencesStore`.
- Render the Cc/Bcc/Reply-To block when `alwaysShowCcBcc || showCcBcc`.
- Use a single toggle link:
  - Collapsed: **“Cc / Bcc / Reply-To”**
  - Expanded (and `!alwaysShowCcBcc`): **“Hide Cc/Bcc/Reply-To”**
- When `!alwaysShowCcBcc`, collapse on blur of the address block if Cc/Bcc/Reply-To are all empty.
- Keep the existing move-target menus on each `RecipientField`.

#### Inline reply (`src/components/email/InlineReply.tsx`)

- Apply the same `alwaysShowCcBcc` preference and expand/collapse-on-blur behavior.
- Update `showCcBcc` initialization to also consider whether any Cc/Bcc/Reply-To are pre-filled.

### 5. Preserve inline images when forwarding

Modify `prepareBodyForQuoting.ts`:

- Add an optional `cidMap?: Map<string, string>` parameter.
- When a map is provided, replace `src="cid:..."` with the corresponding `data:` URL instead of stripping the image.
- When no map is provided, keep the current strip behavior for replies.

In `buildComposerOpenOptions`, for `mode === 'forward'`:

1. Call `fetchInlineImages(accountId, message.id)`.
2. Build `cidMap` from `contentId` → `data:${mimeType};base64,${base64}`.
3. Pass the map into `buildForwardQuote(message, cidMap)`.

This makes forwarded inline images render in the editor and be converted to CID attachments at send time by `buildSendDraft`.

### 6. Signature placement fix

No new signature algorithm is needed. Once the modal composer receives a `bodyHtml` that contains a `.gmail_quote` block, the existing `applySignatureAboveQuote` in `Composer.tsx` will insert the signature above it. The fix is purely to ensure the quote body is built in step 1.

### 7. Keep `InlineReply.tsx` consistent

- Use the same `buildComposerOpenOptions` helper for the initial recipients, subject, and body so the inline and modal paths do not diverge again.
- Continue to seed forwarded attachments as file attachments locally; for inline images the CID substitution path handles rendering.

### 8. Tests

- **New:** `tests/features/composer/buildComposerOpenOptions.test.ts`
  - Reply: To uses `Reply-To` header or sender, subject `Re:`, body contains `gmail_quote`, `inReplyToMessageId` set.
  - Reply-All: To/Cc exclude own addresses.
  - Forward: subject `Fwd:`, quoted body, `originalMessageId` + `includeOriginalAttachments: true`, inline `cid:` refs replaced with `data:` URLs.
  - Forward as attachment: `forwardAsAttachment: true`, no inline quote.
  - Reply with attachments: `originalMessageId` + `includeOriginalAttachments: true`.
  - Smart From resolves to the alias the message was addressed to.
- **Update:** `tests/services/db/threads.test.ts` — assert `reply_to` is parsed into `replyTo`.
- **Update:** `tests/stores/preferencesStore.test.ts` — include `alwaysShowCcBcc`.
- **Update / add:** component tests for `Composer` and `InlineReply` toggle behavior.

### 9. Verification

1. Type-check:
   ```bash
   cd kylins.client.frontend
   npx tsc --noEmit
   ```
2. Tests:
   ```bash
   npx vitest run tests/features/composer/buildComposerOpenOptions.test.ts
   npx vitest run tests/services/db/threads.test.ts
   npx vitest run tests/stores/preferencesStore.test.ts
   ```
3. Manual smoke test:
   - Select a message with a `Reply-To` header; click **Reply** in the ribbon — verify To is the `Reply-To` address, subject is `Re:`, body quotes the original, signature sits above the quote.
   - Click **Reply All** — verify To/Cc exclude your own addresses.
   - Click **Forward** — verify subject `Fwd:`, quoted body, original file attachments listed, inline images visible inside the quoted body.
   - Click **Forward as Attachment** — verify only an `.eml` attachment is created and the body is empty.
   - Toggle Cc/Bcc/Reply-To open, leave focus, verify collapse when empty unless `alwaysShowCcBcc` is enabled.

## Critical files to create / modify

- **Create:** `src/features/composer/buildComposerOpenOptions.ts`
- **Modify:** `src/utils/composerActions.ts`
- **Modify:** `src/components/layout/ribbon/ReadRibbon.tsx`
- **Modify:** `src/components/layout/MessageList.tsx`
- **Modify:** `src/components/composer/Composer.tsx`
- **Modify:** `src/components/email/InlineReply.tsx`
- **Modify:** `src/features/composer/prepareBodyForQuoting.ts`
- **Modify:** `src/services/db/threads.ts`
- **Modify:** `src/services/settingsKeys.ts`
- **Modify:** `src/stores/preferencesStore.ts`
- **Modify:** `src/components/preferences/GeneralPreferences.tsx`
- **Modify / add:** tests under `tests/features/composer/`, `tests/services/db/`, `tests/stores/`

## Sources consulted

- Local Kylins Client frontend source and the inline reply implementation in `InlineReply.tsx`.
- Thunderbird Desktop source at `D:\Projects\mailclient\opensource\thunderbird-desktop` (compose addressing, quoting, signature placement).
- Thunderbird support docs and community references:
  - [Addressing an Email](https://support.mozilla.org/en-US/kb/addressing-email)
  - [How to permanently show CC/BCC](https://support.mozilla.org/gl/questions/1401409)
  - [Signature position settings](https://support.mozilla.org/gl/questions/1572350)
  - [Configuration Options for Accounts](https://support.mozilla.org/en-US/kb/configuration-options-accounts)
  - [Forward Email as Attachment](https://www.thunderbirdconverter.com/blog/forward-email-as-attachment-thunderbird/)
  - [Thunderbird does not forward attachments](https://forums.gentoo.org/viewtopic.php?t=1122365)
  - [Reply with Attachments add-on](https://github.com/bitranox/Thunderbird-Reply-with-Attachments)
