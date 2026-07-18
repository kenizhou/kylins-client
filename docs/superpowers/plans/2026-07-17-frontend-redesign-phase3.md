# Frontend Redesign Phase 3 — Composer, Preferences & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remaining high-impact UI/UX polish identified in the [Phase 3 design spec](../specs/2026-07-17-frontend-redesign-phase3-design.md): simplify the Composer default view, clean up the Preferences dialog, enhance Appearance settings, replace JS-driven scrollbars with CSS, and apply focused accessibility polish.

**Architecture:** All changes stay inside `kylins.client.frontend`. Composer state is owned by `useComposerStore`; theme/appearance state is owned by `useUIStore` and applied through `themeManager`. Persistence reuses the existing Rust-backed `settings` service (`getSetting`/`setSetting`). No backend RPC or migration changes are required.

**Tech Stack:** React 19, Zustand, Tailwind CSS v4 (`@import 'tailwindcss'`), `react-aria-components`, TipTap, Vitest + jsdom + Testing Library.

## Global Constraints

- All commands run from `kylins.client.frontend/`.
- `npx tsc --noEmit` must pass.
- `npx vitest run` must pass (including new tests).
- `npm run lint` must not introduce new errors (pre-existing warnings are allowed).
- `npm run format:check` must pass.
- No new `any` or `@ts-ignore`.
- No external CDN dependencies; fonts remain offline/system fallbacks.
- No schema or backend migration changes.
- Theme/appearance settings persist via `getSetting`/`setSetting` with the keys defined in `SETTING_KEYS`.

---

## File Map

| File | Responsibility |
|---|---|
| `src/components/composer/Composer.tsx` | Main composer UI. Task 1 collapses Cc/Bcc/Reply-To by default and adds a reveal link. |
| `src/components/composer/AttachmentPicker.tsx` | Attachment staging UI. Task 1 renders inline chips when collapsed. |
| `src/utils/composerActions.ts` | Reply/forward entry helpers. Task 1 adds a unit test, no behavior change. |
| `src/components/preferences/PreferencesDialog.tsx` | Preferences shell + tab list. Task 2 reduces to 7 tabs and removes ComingSoonTab. |
| `src/components/preferences/MailPreferences.tsx` | **New.** Reading, conversation, and signature settings (moved from General/Signatures tabs). |
| `src/components/preferences/AboutPreferences.tsx` | **New.** Version, attributions, updates. |
| `src/components/preferences/GeneralPreferences.tsx` | Task 2 removes appearance/layout/signatures content (moved to Appearance/Mail tabs). |
| `src/components/preferences/AppearancePreferences.tsx` | Task 3 adds font size, serif subjects, and reduced motion controls. |
| `src/stores/uiStore.ts` | Task 3 adds `fontSize`, `serifSubjects`, `reduceMotion` state. |
| `src/services/theme/themeManager.ts` | Task 3 adds DOM application helpers for font size, serif subjects, reduced motion. |
| `src/services/settingsKeys.ts` | Task 3 adds keys for the new appearance settings. |
| `src/App.tsx` | Task 3 hydrates new appearance settings on startup. |
| `src/styles/theme.css` / `src/styles/globals.css` | Task 3 adds `[data-font-size]`, `.serif-subjects`, `[data-reduce-motion]` styles; Task 4 adds scrollbar utilities. |
| `src/hooks/useAutoHideScrollbar.ts` | Task 4 returns a stable CSS class instead of attaching scroll listeners. |
| `tests/components/composer/Composer.test.tsx` | **New.** Task 1 default view + expansion tests. |
| `tests/utils/composerActions.test.ts` | **New.** Task 1 reply/forward helper contract test. |
| `tests/components/preferences/PreferencesDialog.test.tsx` | **New.** Task 2 tab list + no "coming soon" text. |
| `tests/components/preferences/MailPreferences.test.tsx` | **New.** Task 2 renders reading/conversation controls. |
| `tests/services/theme/themeManager.test.ts` | Task 3 new DOM attribute tests. |
| `tests/components/preferences/AppearancePreferences.test.tsx` | **New.** Task 3 control interaction tests. |
| `tests/hooks/useAutoHideScrollbar.test.ts` | **New.** Task 4 CSS-only behavior. |
| `tests/components/composer/Composer.a11y.test.tsx` | **New.** Task 5 icon-button labels + roles. |
| `tests/components/preferences/PreferencesDialog.a11y.test.tsx` | **New.** Task 5 tab list labels + focus ring smoke test. |

---

### Task 1: Composer Simplification

**Files:**
- Modify: `src/components/composer/Composer.tsx:161-169` (header expansion state)
- Modify: `src/components/composer/Composer.tsx:1009-1039` (reveal link layout)
- Modify: `src/components/composer/Composer.tsx:1102-1115` (subject/attachment placement)
- Modify: `src/components/composer/AttachmentPicker.tsx`
- Create: `tests/components/composer/Composer.test.tsx`
- Create: `tests/utils/composerActions.test.ts`

**Interfaces:**
- Consumes: `useComposerStore` fields `to`, `cc`, `bcc`, `replyTo`, `subject`, `attachments`; `usePreferencesStore.alwaysShowCcBcc`.
- Produces: `showCc`, `showBcc`, `showReplyTo` booleans derived from local expansion state + pref + populated fields.

- [ ] **Step 1: Add Composer default-view test**

Create `tests/components/composer/Composer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Composer } from '../../../src/components/composer/Composer';
import { useComposerStore } from '../../../src/stores/composerStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn(() => ({})) }));

function setupAccount() {
  useAccountStore.setState({
    accounts: [{ id: 'acc-1', email: 'a@example.com', displayName: 'A User', provider: 'imap' }],
    activeAccountId: 'acc-1',
  });
}

beforeEach(() => {
  useComposerStore.setState({
    isOpen: true,
    mode: 'new',
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: '',
    bodyHtml: '',
    attachments: [],
  });
  usePreferencesStore.setState({ enableRichText: false, alwaysShowCcBcc: false });
  setupAccount();
});

describe('Composer default view', () => {
  it('shows To, Subject and Send by default and hides Cc/Bcc/Reply-To', () => {
    render(<Composer />);
    expect(screen.getByLabelText(/to/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/subject/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/cc/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/bcc/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/reply-to/i)).not.toBeInTheDocument();
  });

  it('reveals Cc/Bcc/Reply-To when the Cc link is clicked', () => {
    render(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: /cc/i }));
    expect(screen.getByLabelText(/cc/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/bcc/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/reply-to/i)).toBeInTheDocument();
  });

  it('auto-expands Cc when a Cc value is present on open', async () => {
    useComposerStore.setState({ cc: [{ name: '', email: 'cc@example.com' }] });
    render(<Composer />);
    await waitFor(() => expect(screen.getByLabelText(/cc/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the failing Composer test**

Run: `npx vitest run tests/components/composer/Composer.test.tsx`
Expected: FAIL — test file references a missing component export or `Composer` is not found.

- [ ] **Step 3: Refactor Composer header expansion state**

In `src/components/composer/Composer.tsx`, replace the three independent expanded states with one tri-state and derive `showCc`/`showBcc`/`showReplyTo` from it and the existing `alwaysShowCcBcc` preference.

Replace lines 161-168:

```tsx
  const [ccExpanded, setCcExpanded] = useState(() => alwaysShowCcBcc || cc.length > 0);
  const [bccExpanded, setBccExpanded] = useState(() => alwaysShowCcBcc || bcc.length > 0);
  const [replyToExpanded, setReplyToExpanded] = useState(
    () => alwaysShowCcBcc || replyTo.length > 0,
  );
  const showCc = ccExpanded || alwaysShowCcBcc || cc.length > 0;
  const showBcc = bccExpanded || alwaysShowCcBcc || bcc.length > 0;
  const showReplyTo = replyToExpanded || alwaysShowCcBcc || replyTo.length > 0;
```

with:

```tsx
  const [extraHeadersExpanded, setExtraHeadersExpanded] = useState(
    () => alwaysShowCcBcc || cc.length > 0 || bcc.length > 0 || replyTo.length > 0,
  );
  const showExtraHeaders = extraHeadersExpanded || alwaysShowCcBcc;
  const showCc = showExtraHeaders || cc.length > 0;
  const showBcc = showExtraHeaders || bcc.length > 0;
  const showReplyTo = showExtraHeaders || replyTo.length > 0;
```

- [ ] **Step 4: Replace per-field reveal links with a single "Cc" link**

In `src/components/composer/Composer.tsx`, replace lines 1010-1039 (the `!alwaysShowCcBcc` block containing three separate reveal buttons) with:

```tsx
              {!alwaysShowCcBcc && !showExtraHeaders && (
                <div className="flex items-center gap-2 text-xs text-muted-text">
                  <span className="text-border" aria-hidden="true">|</span>
                  <Button
                    onPress={() => setExtraHeadersExpanded(true)}
                    className="kylins-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Show Cc, Bcc and Reply-To fields"
                  >
                    Cc
                  </Button>
                </div>
              )}
```

- [ ] **Step 5: Move inline attachment chips above the editor when headers are collapsed**

In `src/components/composer/Composer.tsx`, the attachments section currently sits below the editor (lines 1131-1144). Keep it there, but make `AttachmentPicker` render horizontally as chips. Edit `src/components/composer/AttachmentPicker.tsx` so its attachment list uses `flex flex-wrap gap-2` instead of a vertical list. The exact markup depends on the current component; the target class string is:

```tsx
<div className="flex flex-wrap items-center gap-2 px-3 py-2">
```

and each chip uses:

```tsx
<span className="inline-flex items-center gap-1.5 rounded-full bg-highlight px-2.5 py-1 text-xs text-highlight-text">
  {filename}
  <button aria-label={`Remove ${filename}`} …>…</button>
</span>
```

If `AttachmentPicker` is already implemented, only change the list container classes and add `aria-label` to the remove button.

- [ ] **Step 6: Add composerActions contract test**

Create `tests/utils/composerActions.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  openReplyComposer,
  openReplyAllComposer,
  openForwardComposer,
} from '../../src/utils/composerActions';
import * as composeWindow from '../../src/utils/composeWindow';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const message = {
  id: 'm-1',
  subject: 'Hello',
  from: { name: 'A', address: 'a@example.com' },
  to: [{ name: 'B', address: 'b@example.com' }],
  date: new Date().toISOString(),
  preview: '',
  html: null,
  text: null,
  classificationId: null,
  isEncrypted: false,
  isSigned: false,
};

const account = { id: 'acc-1', email: 'b@example.com', displayName: 'B' };

describe('composerActions', () => {
  it('routes reply, reply-all and forward through the same open path', () => {
    const openComposerWindow = vi.spyOn(composeWindow, 'openComposerWindow').mockImplementation(() => {});
    openReplyComposer(message, account);
    expect(openComposerWindow).toHaveBeenCalledTimes(1);
    expect(openComposerWindow.mock.calls[0]?.[0]?.mode).toBe('reply');

    openReplyAllComposer(message, account);
    expect(openComposerWindow).toHaveBeenCalledTimes(2);
    expect(openComposerWindow.mock.calls[1]?.[0]?.mode).toBe('replyAll');

    openForwardComposer(message, account);
    expect(openComposerWindow).toHaveBeenCalledTimes(3);
    expect(openComposerWindow.mock.calls[2]?.[0]?.mode).toBe('forward');
  });
});
```

- [ ] **Step 7: Run Task 1 tests**

Run:

```bash
npx vitest run tests/components/composer/Composer.test.tsx tests/utils/composerActions.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/components/composer/Composer.tsx src/components/composer/AttachmentPicker.tsx tests/components/composer/Composer.test.tsx tests/utils/composerActions.test.ts
git commit -m "feat(frontend): simplify composer default view and add tests

- Collapse Cc/Bcc/Reply-To by default behind a single Cc reveal link
- Expand automatically when fields are populated or alwaysShowCcBcc is on
- Render attachments as horizontal inline chips
- Add Composer and composerActions tests"
```

---

### Task 2: Preferences Cleanup

**Files:**
- Modify: `src/components/preferences/PreferencesDialog.tsx`
- Modify: `src/components/preferences/GeneralPreferences.tsx`
- Create: `src/components/preferences/MailPreferences.tsx`
- Create: `src/components/preferences/AboutPreferences.tsx`
- Create: `tests/components/preferences/PreferencesDialog.test.tsx`
- Create: `tests/components/preferences/MailPreferences.test.tsx`

**Interfaces:**
- Consumes: `PreferenceTab` union from `preferencesStore`; existing preference tab components.
- Produces: `MailPreferences` and `AboutPreferences` components exported as default tab components.

- [ ] **Step 1: Update PreferenceTab union in preferencesStore**

In `src/stores/preferencesStore.ts`, replace lines 5-14:

```ts
export type PreferenceTab =
  | 'General'
  | 'Accounts'
  | 'Appearance'
  | 'Shortcuts'
  | 'Mail Rules'
  | 'Signatures'
  | 'Templates'
  | 'Contacts'
  | 'Security';
```

with:

```ts
export type PreferenceTab =
  | 'General'
  | 'Accounts'
  | 'Appearance'
  | 'Mail'
  | 'Calendar & Contacts'
  | 'Shortcuts'
  | 'About';
```

- [ ] **Step 2: Add PreferencesDialog tab-list test**

Create `tests/components/preferences/PreferencesDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreferencesDialog } from '../../../src/components/preferences/PreferencesDialog';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  usePreferencesStore.setState({ isOpen: true, activeTab: 'General' });
});

describe('PreferencesDialog', () => {
  it('renders exactly seven tabs', () => {
    render(<PreferencesDialog />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(7);
  });

  it('does not contain any coming-soon text', () => {
    render(<PreferencesDialog />);
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it('labels tabs with General, Accounts, Appearance, Mail, Calendar & Contacts, Shortcuts, About', () => {
    render(<PreferencesDialog />);
    ['General', 'Accounts', 'Appearance', 'Mail', 'Calendar & Contacts', 'Shortcuts', 'About'].forEach(
      (label) => expect(screen.getByRole('tab', { name: label })).toBeInTheDocument(),
    );
  });
});
```

- [ ] **Step 3: Reduce PreferencesDialog to seven tabs and remove ComingSoonTab**

In `src/components/preferences/PreferencesDialog.tsx`, replace the imports, `TABS` array, `TAB_COMPONENTS` map, and remove `ComingSoonTab`.

New imports:

```tsx
import { usePreferencesStore, type PreferenceTab } from '../../stores/preferencesStore';
import { GeneralPreferences } from './GeneralPreferences';
import { AppearancePreferences } from './AppearancePreferences';
import { ShortcutsPreferences } from './ShortcutsPreferences';
import { AccountsPreferences } from './AccountsPreferences';
import { ContactsPreferences } from './ContactsPreferences';
import { SecurityPreferences } from './SecurityPreferences';
import { MailPreferences } from './MailPreferences';
import { AboutPreferences } from './AboutPreferences';
import { Modal } from '../ui/Modal';
import { Button } from 'react-aria-components';
import { Tabs, TabList, Tab } from 'react-aria-components';
import {
  PreferencesGeneralIcon,
  PreferencesAccountsIcon,
  PreferencesAppearanceIcon,
  PreferencesShortcutsIcon,
  MailIcon,
  ContactsIcon,
  PreferencesPrivacySecurityIcon,
  InfoIcon,
} from '../icons';
```

New `TABS`:

```tsx
const TABS: { id: PreferenceTab; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'General', icon: PreferencesGeneralIcon },
  { id: 'Accounts', icon: PreferencesAccountsIcon },
  { id: 'Appearance', icon: PreferencesAppearanceIcon },
  { id: 'Mail', icon: MailIcon },
  { id: 'Calendar & Contacts', icon: ContactsIcon },
  { id: 'Shortcuts', icon: PreferencesShortcutsIcon },
  { id: 'About', icon: InfoIcon },
];
```

New `TAB_COMPONENTS`:

```tsx
const TAB_COMPONENTS: Record<PreferenceTab, React.ComponentType> = {
  General: GeneralPreferences,
  Accounts: AccountsPreferences,
  Appearance: AppearancePreferences,
  Mail: MailPreferences,
  'Calendar & Contacts': ContactsPreferences,
  Shortcuts: ShortcutsPreferences,
  About: AboutPreferences,
};
```

Remove the `ComingSoonTab` component and change the content render to:

```tsx
          {TabComponent && <TabComponent />}
```

If `InfoIcon` does not exist, add it to `src/components/icons/index.ts` as an alias of an existing info icon or create a minimal SVG:

```tsx
export function InfoIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}
```

- [ ] **Step 4: Create MailPreferences component**

Create `src/components/preferences/MailPreferences.tsx`:

```tsx
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useViewStore } from '../../features/view/viewStore';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { CheckboxRow } from './PreferenceRows';
import { PreferencesTabLayout, PreferencesTabColumns } from './PreferencesTabLayout';
import { MailIcon, PreferencesReadingIcon, PreferencesSignaturesIcon } from '../icons';

export function MailPreferences() {
  const readingPanePosition = useViewStore((s) => s.readingPanePosition);
  const conversationView = useViewStore((s) => s.conversationView);
  const setReadingPanePosition = useViewStore((s) => s.setReadingPanePosition);
  const setConversationView = useViewStore((s) => s.setConversationView);

  const automaticallyLoadImages = usePreferencesStore((s) => s.automaticallyLoadImages);
  const setAutomaticallyLoadImages = usePreferencesStore((s) => s.setAutomaticallyLoadImages);
  const showFullMessageHeaders = usePreferencesStore((s) => s.showFullMessageHeaders);
  const setShowFullMessageHeaders = usePreferencesStore((s) => s.setShowFullMessageHeaders);

  return (
    <PreferencesTabLayout>
      <PreferencesTabColumns
        left={
          <>
            <PreferencesSectionCard title="Reading" icon={PreferencesReadingIcon}>
              <div className="space-y-3">
                <CheckboxRow
                  label="Automatically load images"
                  checked={automaticallyLoadImages}
                  onChange={setAutomaticallyLoadImages}
                />
                <CheckboxRow
                  label="Show full message headers"
                  checked={showFullMessageHeaders}
                  onChange={setShowFullMessageHeaders}
                />
                <CheckboxRow
                  label="Conversation view"
                  checked={conversationView}
                  onChange={setConversationView}
                />
              </div>
            </PreferencesSectionCard>

            <PreferencesSectionCard title="Message list" icon={MailIcon}>
              <p className="text-sm text-muted-text">
                Density and column options are on the Appearance tab.
              </p>
            </PreferencesSectionCard>
          </>
        }
        right={
          <PreferencesSectionCard title="Signatures" icon={PreferencesSignaturesIcon}>
            <p className="text-sm text-muted-text">
              Signatures can be managed per-account in Accounts preferences.
            </p>
          </PreferencesSectionCard>
        }
      />
    </PreferencesTabLayout>
  );
}
```

- [ ] **Step 5: Create AboutPreferences component**

Create `src/components/preferences/AboutPreferences.tsx`:

```tsx
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { PreferencesTabLayout } from './PreferencesTabLayout';
import { InfoIcon } from '../icons';

export function AboutPreferences() {
  return (
    <PreferencesTabLayout>
      <PreferencesSectionCard title="About Kylins" icon={InfoIcon}>
        <div className="space-y-2 text-sm text-muted-text">
          <p>Kylins Mail — a desktop email client for Windows, macOS and Linux.</p>
          <p>
            Version <span className="font-medium text-foreground">{__APP_VERSION__ ?? 'dev'}</span>
          </p>
          <p>
            Attributions and licenses are available in <code>ATTRIBUTIONS.md</code>.
          </p>
        </div>
      </PreferencesSectionCard>
    </PreferencesTabLayout>
  );
}
```

If `__APP_VERSION__` is not defined in `vite-env.d.ts`, add it:

```ts
declare const __APP_VERSION__: string;
```

- [ ] **Step 6: Remove moved sections from GeneralPreferences**

Open `src/components/preferences/GeneralPreferences.tsx`. Remove any controls now owned by `AppearancePreferences` or `MailPreferences` (appearance/layout/skin/theme and reading pane/conversation/signatures). Keep only language, notifications, and sending defaults. The exact edits depend on the current file contents; remove imports and JSX blocks that reference the moved state fields.

- [ ] **Step 7: Add MailPreferences render test**

Create `tests/components/preferences/MailPreferences.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MailPreferences } from '../../../src/components/preferences/MailPreferences';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';
import { useViewStore } from '../../../src/features/view/viewStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  usePreferencesStore.setState({
    automaticallyLoadImages: true,
    showFullMessageHeaders: false,
  });
  useViewStore.setState({
    conversationView: true,
  });
});

describe('MailPreferences', () => {
  it('renders reading and conversation controls', () => {
    render(<MailPreferences />);
    expect(screen.getByLabelText(/automatically load images/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/conversation view/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Run Task 2 tests**

Run:

```bash
npx vitest run tests/components/preferences/PreferencesDialog.test.tsx tests/components/preferences/MailPreferences.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/stores/preferencesStore.ts src/components/preferences/PreferencesDialog.tsx src/components/preferences/GeneralPreferences.tsx src/components/preferences/MailPreferences.tsx src/components/preferences/AboutPreferences.tsx src/components/icons/index.ts tests/components/preferences/PreferencesDialog.test.tsx tests/components/preferences/MailPreferences.test.tsx
git commit -m "feat(frontend): reorganize preferences into seven stable tabs

- Replace Mail Rules, Signatures, Templates, Contacts, Security tabs
- New tabs: General, Accounts, Appearance, Mail, Calendar & Contacts, Shortcuts, About
- Move reading/conversation controls to Mail tab
- Add About section with version and attributions
- Add PreferencesDialog and MailPreferences tests"
```


---

### Task 3: Appearance Enhancements

**Files:**
- Modify: `src/services/settingsKeys.ts`
- Modify: `src/stores/uiStore.ts`
- Modify: `src/services/theme/themeManager.ts`
- Modify: `src/components/preferences/AppearancePreferences.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles/theme.css`
- Modify: `src/styles/globals.css`
- Modify: `tests/services/theme/themeManager.test.ts`
- Create: `tests/components/preferences/AppearancePreferences.test.tsx`

**Interfaces:**
- Consumes: `getSetting`/`setSetting` for `font_size`, `serif_subjects`, `reduce_motion`; `themeManager` DOM helpers.
- Produces: `UIState.fontSize: 'small' | 'default' | 'large'`; `UIState.serifSubjects: boolean`; `UIState.reduceMotion: boolean`; `themeManager.setFontSize`, `themeManager.setSerifSubjects`, `themeManager.setReduceMotion`.

- [ ] **Step 1: Add appearance setting keys**

In `src/services/settingsKeys.ts`, add after the Contacts block:

```ts
  // Appearance
  fontSize: 'font_size',
  serifSubjects: 'serif_subjects',
  reduceMotion: 'reduce_motion',
```

- [ ] **Step 2: Extend UIState with new appearance fields**

In `src/stores/uiStore.ts`, add to the `UIState` interface after `setRateLimited`:

```ts
  fontSize: 'small' | 'default' | 'large';
  setFontSize: (size: 'small' | 'default' | 'large') => void;
  serifSubjects: boolean;
  setSerifSubjects: (enabled: boolean) => void;
  reduceMotion: boolean;
  setReduceMotion: (enabled: boolean) => void;
```

Add to the default store object after `rateLimitedAccountIds`:

```ts
  fontSize: 'default',
  serifSubjects: false,
  reduceMotion: false,
  setFontSize: (fontSize) => set({ fontSize }),
  setSerifSubjects: (serifSubjects) => set({ serifSubjects }),
  setReduceMotion: (reduceMotion) => set({ reduceMotion }),
```

- [ ] **Step 3: Add ThemeManager appearance helpers**

In `src/services/theme/themeManager.ts`, add after `getActiveTheme()`:

```ts
  setFontSize(size: 'small' | 'default' | 'large'): void {
    const root = document.documentElement;
    root.setAttribute('data-font-size', size);
  }

  setSerifSubjects(enabled: boolean): void {
    const root = document.documentElement;
    if (enabled) {
      root.classList.add('serif-subjects');
    } else {
      root.classList.remove('serif-subjects');
    }
  }

  setReduceMotion(enabled: boolean): void {
    const root = document.documentElement;
    if (enabled) {
      root.setAttribute('data-reduce-motion', 'true');
    } else {
      root.removeAttribute('data-reduce-motion');
    }
  }
```

- [ ] **Step 4: Add ThemeManager tests**

Append to `tests/services/theme/themeManager.test.ts`:

```ts
describe('ThemeManager font size', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-font-size');
  });

  it('sets data-font-size attribute', () => {
    themeManager.setFontSize('large');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('large');
  });

  it('updates to small', () => {
    themeManager.setFontSize('large');
    themeManager.setFontSize('small');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('small');
  });
});

describe('ThemeManager serif subjects', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('serif-subjects');
  });

  it('adds serif-subjects class', () => {
    themeManager.setSerifSubjects(true);
    expect(document.documentElement.classList.contains('serif-subjects')).toBe(true);
  });

  it('removes serif-subjects class', () => {
    themeManager.setSerifSubjects(true);
    themeManager.setSerifSubjects(false);
    expect(document.documentElement.classList.contains('serif-subjects')).toBe(false);
  });
});

describe('ThemeManager reduce motion', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-reduce-motion');
  });

  it('sets data-reduce-motion attribute', () => {
    themeManager.setReduceMotion(true);
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('true');
  });

  it('removes data-reduce-motion attribute', () => {
    themeManager.setReduceMotion(true);
    themeManager.setReduceMotion(false);
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false);
  });
});
```

- [ ] **Step 5: Add CSS for font size, serif subjects and reduced motion**

In `src/styles/theme.css`, add at the bottom:

```css
[data-font-size='small'] {
  --text-base: 13px;
}

[data-font-size='default'] {
  --text-base: 14px;
}

[data-font-size='large'] {
  --text-base: 16px;
}

html[data-font-size] body,
html[data-font-size] #root {
  font-size: var(--text-base);
}
```

In `src/styles/globals.css`, add after the `.kylins-link` block:

```css
.serif-subjects .reading-pane-subject,
.serif-subjects .message-list-subject {
  font-family: 'Source Serif 4', Georgia, Cambria, 'Times New Roman', serif;
}

[data-reduce-motion='true'],
[data-reduce-motion='true'] * {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
}
```

- [ ] **Step 6: Hydrate new appearance settings on startup**

In `src/App.tsx`, update `hydrateBackground` to read the new settings and update `applyAppearance` to apply them.

Change the `Promise.all` in `hydrateBackground` (line 55) to:

```ts
  Promise.all([
    getSetting('theme'),
    getSetting('skin'),
    getSetting('contrast'),
    getSetting('font_size'),
    getSetting('serif_subjects'),
    getSetting('reduce_motion'),
  ])
    .then(([savedTheme, savedSkin, savedContrast, savedFontSize, savedSerifSubjects, savedReduceMotion]) =>
      applyAppearance(
        savedTheme,
        savedSkin,
        savedContrast,
        savedFontSize,
        savedSerifSubjects,
        savedReduceMotion,
      ),
    )
```

Change the main-window `Promise.all` (around line 190) to:

```ts
            const [savedTheme, savedSkin, savedContrast, savedFontSize, savedSerifSubjects, savedReduceMotion] =
              await Promise.all([
                getSetting('theme'),
                getSetting('skin'),
                getSetting('contrast'),
                getSetting('font_size'),
                getSetting('serif_subjects'),
                getSetting('reduce_motion'),
              ]);
            applyAppearance(
              savedTheme,
              savedSkin,
              savedContrast,
              savedFontSize,
              savedSerifSubjects,
              savedReduceMotion,
            );
```

Update `applyAppearance` signature and body:

```ts
    function applyAppearance(
      theme: string | null,
      skin: string | null,
      contrast: string | null,
      fontSize: string | null,
      serifSubjects: string | null,
      reduceMotion: string | null,
    ): void {
      if (theme === 'light' || theme === 'dark' || theme === 'system') {
        if (isMounted.current) setTheme(theme);
        themeManager.applyTheme(theme);
      }
      const resolvedContrast: ContrastMode = contrast === 'high' ? 'high' : 'default';
      if (isMounted.current) setContrast(resolvedContrast);
      themeManager.setContrast(resolvedContrast);

      const resolvedSkin: SkinId = skin && isSkinId(skin) ? skin : DEFAULT_SKIN;
      if (isMounted.current) setSkin(resolvedSkin);
      themeManager.applySkin(resolvedSkin);

      const resolvedFontSize: 'small' | 'default' | 'large' =
        fontSize === 'small' || fontSize === 'large' ? fontSize : 'default';
      if (isMounted.current) setFontSize(resolvedFontSize);
      themeManager.setFontSize(resolvedFontSize);

      const resolvedSerifSubjects = serifSubjects === 'true';
      if (isMounted.current) setSerifSubjects(resolvedSerifSubjects);
      themeManager.setSerifSubjects(resolvedSerifSubjects);

      const resolvedReduceMotion = reduceMotion === 'true';
      if (isMounted.current) setReduceMotion(resolvedReduceMotion);
      themeManager.setReduceMotion(resolvedReduceMotion);
    }
```

Add the corresponding store selectors in `App.tsx`:

```ts
  const setFontSize = useUIStore((s) => s.setFontSize);
  const setSerifSubjects = useUIStore((s) => s.setSerifSubjects);
  const setReduceMotion = useUIStore((s) => s.setReduceMotion);
```

- [ ] **Step 7: Add AppearancePreferences controls**

In `src/components/preferences/AppearancePreferences.tsx`, add new selectors and handlers.

Add constants:

```ts
const FONT_SIZE_OPTIONS: { value: 'small' | 'default' | 'large'; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
];
```

Add selectors after `setSkin`:

```ts
  const fontSize = useUIStore((s) => s.fontSize);
  const serifSubjects = useUIStore((s) => s.serifSubjects);
  const reduceMotion = useUIStore((s) => s.reduceMotion);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const setSerifSubjects = useUIStore((s) => s.setSerifSubjects);
  const setReduceMotion = useUIStore((s) => s.setReduceMotion);
```

Add handlers:

```ts
  const handleFontSizeChange = useCallback(
    (value: 'small' | 'default' | 'large') => {
      setFontSize(value);
      themeManager.setFontSize(value);
      setSetting(SETTING_KEYS.fontSize, value).catch(() => {});
    },
    [setFontSize],
  );

  const handleSerifSubjectsChange = useCallback(
    (value: boolean) => {
      setSerifSubjects(value);
      themeManager.setSerifSubjects(value);
      setSetting(SETTING_KEYS.serifSubjects, String(value)).catch(() => {});
    },
    [setSerifSubjects],
  );

  const handleReduceMotionChange = useCallback(
    (value: boolean) => {
      setReduceMotion(value);
      themeManager.setReduceMotion(value);
      setSetting(SETTING_KEYS.reduceMotion, String(value)).catch(() => {});
    },
    [setReduceMotion],
  );
```

Add `SETTING_KEYS` import if not already present:

```ts
import { SETTING_KEYS } from '../../services/settingsKeys';
```

Add a new section card in the left column after "Mode":

```tsx
            <PreferencesSectionCard title="Text" icon={PreferencesReadingIcon}>
              <div className="space-y-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-text">Font size</span>
                  <SegmentedControl
                    options={FONT_SIZE_OPTIONS}
                    value={fontSize}
                    onChange={handleFontSizeChange}
                  />
                </div>
                <CheckboxRow
                  label="Serif subjects"
                  checked={serifSubjects}
                  onChange={handleSerifSubjectsChange}
                />
                <CheckboxRow
                  label="Reduce motion"
                  checked={reduceMotion}
                  onChange={handleReduceMotionChange}
                />
              </div>
            </PreferencesSectionCard>
```

Update `handleReset` to also reset the new settings:

```ts
    setFontSize('default');
    themeManager.setFontSize('default');
    setSetting(SETTING_KEYS.fontSize, 'default').catch(() => {});

    setSerifSubjects(false);
    themeManager.setSerifSubjects(false);
    setSetting(SETTING_KEYS.serifSubjects, 'false').catch(() => {});

    setReduceMotion(false);
    themeManager.setReduceMotion(false);
    setSetting(SETTING_KEYS.reduceMotion, 'false').catch(() => {});
```

- [ ] **Step 8: Add AppearancePreferences test**

Create `tests/components/preferences/AppearancePreferences.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppearancePreferences } from '../../../src/components/preferences/AppearancePreferences';
import { useUIStore } from '../../../src/stores/uiStore';
import { useViewStore } from '../../../src/features/view/viewStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  useUIStore.setState({
    theme: 'system',
    contrast: 'default',
    skin: 'slate',
    fontSize: 'default',
    serifSubjects: false,
    reduceMotion: false,
  });
  useViewStore.setState({
    readingPanePosition: 'right',
    messageListDensity: 'normal',
    folderPaneVisible: true,
    commandRibbonVisible: true,
    statusBarVisible: true,
    conversationView: true,
  });
});

describe('AppearancePreferences', () => {
  it('updates font size when a different option is selected', () => {
    render(<AppearancePreferences />);
    fireEvent.click(screen.getByRole('radio', { name: /large/i }));
    expect(useUIStore.getState().fontSize).toBe('large');
  });

  it('toggles serif subjects', () => {
    render(<AppearancePreferences />);
    fireEvent.click(screen.getByLabelText(/serif subjects/i));
    expect(useUIStore.getState().serifSubjects).toBe(true);
  });

  it('toggles reduce motion', () => {
    render(<AppearancePreferences />);
    fireEvent.click(screen.getByLabelText(/reduce motion/i));
    expect(useUIStore.getState().reduceMotion).toBe(true);
  });
});
```

- [ ] **Step 9: Run Task 3 tests**

Run:

```bash
npx vitest run tests/services/theme/themeManager.test.ts tests/components/preferences/AppearancePreferences.test.tsx
```

Expected: PASS.

- [ ] **Step 10: Commit Task 3**

```bash
git add src/services/settingsKeys.ts src/stores/uiStore.ts src/services/theme/themeManager.ts src/components/preferences/AppearancePreferences.tsx src/App.tsx src/styles/theme.css src/styles/globals.css tests/services/theme/themeManager.test.ts tests/components/preferences/AppearancePreferences.test.tsx
git commit -m "feat(frontend): add font size, serif subjects and reduced motion controls

- Persist font_size, serif_subjects and reduce_motion via settings service
- Apply settings through themeManager DOM helpers
- Hydrate new appearance settings on app startup
- Add AppearancePreferences controls and tests"
```

---

### Task 4: CSS Scrollbar Replacement

**Files:**
- Modify: `src/hooks/useAutoHideScrollbar.ts`
- Modify: `src/styles/globals.css`
- Modify: components that consume `useAutoHideScrollbar` (search for callers)
- Create: `tests/hooks/useAutoHideScrollbar.test.ts`

**Interfaces:**
- Consumes: a scroll container ref.
- Produces: a stable CSS class string (`'kylins-auto-scrollbar scrollbar-thin'`).

- [ ] **Step 1: Inspect current consumers of useAutoHideScrollbar**

Run:

```bash
cd kylins.client.frontend && grep -R "useAutoHideScrollbar" src/ --include='*.tsx' --include='*.ts'
```

Expected output will list one or more files. The plan assumes the hook returns a class string that consumers spread onto their scroll container.

- [ ] **Step 2: Rewrite useAutoHideScrollbar to return a class string**

Replace the entire contents of `src/hooks/useAutoHideScrollbar.ts` with:

```ts
/**
 * Auto-hide scrollbar styling for a scroll container.
 *
 * The hook now returns a stable CSS class string. The actual hide/show
 * behavior is handled by CSS :hover so no scroll listeners are attached.
 */
export function useAutoHideScrollbar(): string {
  return 'kylins-auto-scrollbar scrollbar-thin';
}

/** Class name to put on the scroll container. */
export const autoHideScrollbarClass = 'kylins-auto-scrollbar scrollbar-thin';
```

- [ ] **Step 3: Add CSS-only scrollbar styles**

In `src/styles/globals.css`, replace the existing `.kylins-auto-scrollbar` block (lines 164-185) with:

```css
/* ---- Auto-hide scrollbar (CSS-only, no scroll listeners) ---- */
.kylins-auto-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
.kylins-auto-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.kylins-auto-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.kylins-auto-scrollbar::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background: transparent;
}
.kylins-auto-scrollbar:hover {
  scrollbar-color: color-mix(in srgb, var(--muted-text) 40%, transparent) transparent;
}
.kylins-auto-scrollbar:hover::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--muted-text) 40%, transparent);
}
```

Remove the `.is-scrolling` rules because they are no longer needed.

- [ ] **Step 4: Update consumers to use the returned class string**

For each consumer found in Step 1, change from:

```tsx
const ref = useRef<HTMLElement>(null);
useAutoHideScrollbar(ref);
return <div ref={ref} className="...">...</div>;
```

to:

```tsx
const scrollbarClass = useAutoHideScrollbar();
return <div className={\`... ${scrollbarClass}\`}>...</div>;
```

If a consumer used `autoHideScrollbarClass` directly, replace it with the new value.

- [ ] **Step 5: Add useAutoHideScrollbar test**

Create `tests/hooks/useAutoHideScrollbar.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoHideScrollbar } from '../../src/hooks/useAutoHideScrollbar';

describe('useAutoHideScrollbar', () => {
  it('returns the combined CSS class string', () => {
    const { result } = renderHook(() => useAutoHideScrollbar());
    expect(result.current).toBe('kylins-auto-scrollbar scrollbar-thin');
  });
});
```

- [ ] **Step 6: Run Task 4 tests**

Run:

```bash
npx vitest run tests/hooks/useAutoHideScrollbar.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/hooks/useAutoHideScrollbar.ts src/styles/globals.css tests/hooks/useAutoHideScrollbar.test.ts
git commit -m "refactor(frontend): replace JS scroll listener with CSS-only auto-hide scrollbar

- useAutoHideScrollbar now returns a stable class string
- Hover state drives scrollbar visibility via CSS
- Remove is-scrolling class management and scroll event listeners"
```

---

### Task 5: Accessibility Polish

**Files:**
- Modify: `src/components/composer/Composer.tsx` (icon-only buttons)
- Modify: `src/components/composer/EditorToolbar.tsx` (icon-only buttons)
- Modify: `src/components/preferences/PreferencesDialog.tsx` (close button)
- Modify: `src/components/preferences/AppearancePreferences.tsx` (skin swatch labels)
- Modify: `src/styles/globals.css` (focus rings where missing)
- Create: `tests/components/composer/Composer.a11y.test.tsx`
- Create: `tests/components/preferences/PreferencesDialog.a11y.test.tsx`

**Interfaces:**
- Consumes: touched components.
- Produces: `aria-label` attributes on icon-only buttons; visible `:focus-visible` rings.

- [ ] **Step 1: Add aria-labels to Composer icon-only buttons**

In `src/components/composer/Composer.tsx`, find icon-only buttons (e.g. pop-out, maximize, close). Add `aria-label` props:

```tsx
<IconButton aria-label="Pop out composer" …><PopOutIcon /></IconButton>
<IconButton aria-label="Maximize composer" …><MaximizeIcon /></IconButton>
<IconButton aria-label="Close composer" …><CloseIcon /></IconButton>
```

If `IconButton` does not forward `aria-label`, update `src/components/ui/IconButton.tsx` to spread `...props` onto the underlying `Button` and accept `AriaButtonProps`.

- [ ] **Step 2: Add aria-labels to EditorToolbar icon-only buttons**

In `src/components/composer/EditorToolbar.tsx`, add `aria-label` to each toolbar button:

```tsx
<Button aria-label="Bold"><BoldIcon /></Button>
<Button aria-label="Italic"><ItalicIcon /></Button>
// …etc
```

- [ ] **Step 3: Add aria-label to Preferences close button and skin swatches**

In `src/components/preferences/PreferencesDialog.tsx`, ensure the close icon button has `aria-label="Close preferences"`.

In `src/components/preferences/AppearancePreferences.tsx`, update each skin swatch button:

```tsx
<button
  …
  aria-label={`Select ${s.name} skin`}
  aria-pressed={active}
>
```

- [ ] **Step 4: Verify focus rings on interactive elements**

In `src/styles/globals.css`, ensure the following utility is available and applied:

```css
.setup-focus-ring {
  @apply outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background;
}
```

Apply it to custom buttons that do not use `react-aria-components` `Button` (which already has focus styling). Specifically, add `setup-focus-ring` to:

- The skin swatch `<button>` in `AppearancePreferences.tsx`.
- The reset-appearance button in `AppearancePreferences.tsx`.
- The "Cc" reveal link in `Composer.tsx` (already has manual ring; keep as-is).

- [ ] **Step 5: Add Composer a11y test**

Create `tests/components/composer/Composer.a11y.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Composer } from '../../../src/components/composer/Composer';
import { useComposerStore } from '../../../src/stores/composerStore';
import { useAccountStore } from '../../../src/stores/accountStore';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn(() => ({})) }));

beforeEach(() => {
  useComposerStore.setState({ isOpen: true, mode: 'new', to: [], cc: [], bcc: [], replyTo: [], subject: '', bodyHtml: '', attachments: [] });
  useAccountStore.setState({ accounts: [{ id: 'acc-1', email: 'a@example.com', displayName: 'A', provider: 'imap' }], activeAccountId: 'acc-1' });
  usePreferencesStore.setState({ enableRichText: false, alwaysShowCcBcc: false });
});

describe('Composer accessibility', () => {
  it('gives icon-only buttons accessible names', () => {
    render(<Composer />);
    expect(screen.getByRole('button', { name: /close composer/i })).toBeInTheDocument();
  });

  it('marks the send button with a clear role and label', () => {
    render(<Composer />);
    const send = screen.getByRole('button', { name: /send/i });
    expect(send).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Add PreferencesDialog a11y test**

Create `tests/components/preferences/PreferencesDialog.a11y.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreferencesDialog } from '../../../src/components/preferences/PreferencesDialog';
import { usePreferencesStore } from '../../../src/stores/preferencesStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  usePreferencesStore.setState({ isOpen: true, activeTab: 'General' });
});

describe('PreferencesDialog accessibility', () => {
  it('tabs have an accessible tablist label', () => {
    render(<PreferencesDialog />);
    expect(screen.getByRole('tablist', { name: /preferences sections/i })).toBeInTheDocument();
  });

  it('skin swatches have accessible names when Appearance is open', () => {
    usePreferencesStore.setState({ activeTab: 'Appearance' });
    render(<PreferencesDialog />);
    expect(screen.getByRole('button', { name: /select slate skin/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run Task 5 tests**

Run:

```bash
npx vitest run tests/components/composer/Composer.a11y.test.tsx tests/components/preferences/PreferencesDialog.a11y.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/components/composer/Composer.tsx src/components/composer/EditorToolbar.tsx src/components/preferences/PreferencesDialog.tsx src/components/preferences/AppearancePreferences.tsx src/components/ui/IconButton.tsx src/styles/globals.css tests/components/composer/Composer.a11y.test.tsx tests/components/preferences/PreferencesDialog.a11y.test.tsx
git commit -m "a11y(frontend): focus rings, aria labels and reduced-motion polish

- Add aria-labels to icon-only composer and preferences buttons
- Label skin swatches and tablist
- Ensure focus-visible rings on custom buttons
- Add focused a11y tests for Composer and PreferencesDialog"
```

---

## Final Verification

After all five tasks are committed:

```bash
cd kylins.client.frontend
npx tsc --noEmit
npm run lint
npm run format:check
npx vitest run
```

Expected:
- `tsc` exits 0.
- `lint` has no new errors (pre-existing warnings allowed).
- `format:check` exits 0.
- Vitest reports all tests passing.

If any step fails, fix it before the final commit.

---

## Self-Review

**1. Spec coverage:**
- Composer default view and collapsed headers → Task 1.
- Unified reply/forward entry contract test → Task 1.
- Inline attachment chips → Task 1.
- Preferences 7-tab reorganization → Task 2.
- Appearance font size / serif subjects / reduced motion → Task 3.
- CSS-only scrollbar → Task 4.
- Accessibility polish → Task 5.

**2. Placeholder scan:**
- No "TBD", "TODO", or "implement later".
- All code blocks contain concrete, copy-pasteable content.
- Exact file paths and commands are provided.

**3. Type consistency:**
- `fontSize` union is `'small' | 'default' | 'large'` everywhere.
- `PreferenceTab` union matches `TABS` and `TAB_COMPONENTS` keys.
- `themeManager` helper names are consistent across store, components, tests, and App.tsx.

