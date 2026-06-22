# Mailclient Main Page Design

## Subject, Audience, and Job

- **Subject:** The main application window of a desktop email client built with Tauri, React, and SQLite.
- **Audience:** Knowledge workers who live in email — managers, engineers, freelancers — and want Outlook-level power with IDE-like density and AI assistance.
- **Single job of this page:** Help the user triage, read, and act on messages as fast as possible without feeling cluttered.

## Design Plan

### Color Tokens

A tight, functional palette derived from the CMMP Outlook AIChat reference. Only six named values; everything else is a semantic use of one of these.

| Token | Light | Dark | Usage |
|---|---|---|---|
| `background` | `#ffffff` | `#111827` | App background behind panes |
| `surface` | `#f9fafb` | `#1f2937` | Header, pane headers, folder pane, status bar |
| `text` | `#111827` | `#f9fafb` | Primary text, sender names, subjects |
| `muted-text` | `#4b5563` | `#9ca3af` | Snippets, timestamps, idle folders |
| `primary` | `#3b82f6` | `#60a5fa` | Selected rows, active tool-window indicator, focus rings |
| `border` | `#e5e7eb` | `#374151` | Pane dividers, row separators, header borders |

Semantic accents are used sparingly and only when state needs to be noticed at a glance:
- `amber` (`#f59e0b` / `#fbbf24`) — follow-up / flagged
- `green` (`#10b981` / `#34d399`) — VIP / safe sender
- `destructive` (`#dc2626` / `#f87171`) — delete, spam

### Typography

- **UI and body:** `Inter` — chosen because it is invisible at small sizes in dense lists, which is exactly what a high-throughput email client needs.
- **Subjects and reading-pane titles:** `Source Serif 4` — the deliberate aesthetic risk. A serif for message subjects gives the app an editorial, "important correspondence" feel and breaks the generic sans-serif default of every other email client. It is used only for subject lines and reading-pane titles; all interactive chrome remains sans-serif.
- **Timestamps and metadata:** `Geist Mono` (or `JetBrains Mono`) — monospaced numbers align cleanly in the message list.

Type scale is small and dense:
- `xs` (11px): status bar, timestamps
- `sm` (13px): folder names, list rows, button labels
- `base` (14px): body text, reading pane
- `lg` (16px): pane headers, section labels
- `xl` (20px): selected subject line in list
- `2xl` (24px): reading-pane subject

### Layout Concept

A desktop-app shell that combines IntelliJ IDEA New UI with Outlook 2024:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ≡  Mailclient        [  Search mail…  ]         [New mail] [⚙] [👤] │  ← HeaderBar
├───┬─────────────────────────────────────────────────────────────────┤
│   │  Folders ▾    │  Focused  Other ▾  │  Coral Gables Project...   │
│ ✉ │  Inbox      9 │  ▶ Kevin Sturgis                 9:30 AM        │
│ 📅│  Sent         │  ▶ Cecil Folk                    1:23 PM        │
│ 👤│  Drafts       │  ▶ Lydia Bauer                  12:55 PM        │
│ 📎│               │                                                │
│ ⚙ │               │                                                │
├───┴───────────────┴─────────────────────┬───────────────────────────┤
│ Status: Synced · 3 accounts             │  3 selected · Offline      │  ← StatusBar
└─────────────────────────────────────────┴───────────────────────────┘
```

- **HeaderBar** spans the top at 40px, simplified like IntelliJ: app identity on the left, search in the center, primary actions on the right.
- **Tool-window bar** is a 44px-wide vertical strip on the left with large 20px icons; labels via tooltips.
- **Folder pane** defaults to 240px, collapsible to 44px mini-mode.
- **Message list** defaults to 360px, resizable.
- **Reading pane** takes the remaining space; subject is set in Source Serif 4.
- **Status bar** is 24px, low contrast, carrying sync state and selection metadata.
- All major panes are separated by resizable dividers.

### Signature Element: The Thread Ribbon

A 3px vertical line on the left edge of every message row and reading-pane message that encodes conversation state:

- **Blue (`primary`)** — unread message in the current thread.
- **Gray (`border`)** — read message.
- **Amber (`amber`)** — flagged for follow-up.
- **Green (`green`)** — from a VIP or safe sender.

In the reading pane, the ribbon extends into a subtle left-edge timeline that shows the thread's back-and-forth, making email feel like a tracked conversation rather than a flat list. This is the single memorable thing; everything else is kept quiet so the ribbon can do its job.

### Motion

- Pane collapse/expand: 150ms ease-out width transition.
- Theme switch: 100ms color transition on CSS variables.
- Message selection: instant background swap; no fade — snappiness is the priority.
- New mail indicator: a single subtle bounce on the Inbox icon, not a flashing badge.
- AI thinking state: a slow pulse on the AI tool-window icon.

### Density Modes

- **Compact:** 28px list rows, 32px pane headers, 10px side padding.
- **Comfortable:** 40px list rows, 40px pane headers, 16px side padding.

### Accessibility

- All color-coded states have an additional shape or icon indicator (unread dot, flag icon, shield icon).
- Keyboard focus rings use the `primary` token with 2px offset.
- Reduced motion disables pane animations and timeline pulses.

## Self-Critique

**What could read as generic:** A clean blue-and-white Outlook clone with a sidebar and three panes is the default answer for an email client. The constraints already lock us into Outlook-like structure, so the distinctiveness has to come from the details.

**What was changed to avoid defaults:**
1. **Source Serif 4 for subjects** — most email clients use one sans family everywhere. The serif subject is the one aesthetic risk; it signals "this is correspondence, not a chat app."
2. **Thread Ribbon as the primary attention signal** — instead of relying on bold text, unread badges, and star icons like every other client, color-coded left-edge ribbons become the main triage language. Shape and icon backups prevent color-only dependence.
3. **IntelliJ-style tool-window bar** — the left bar is icon-first and 44px wide with large icons, not the narrow 32px sidebar common in webmail. This borrows from an IDE, not a website.
4. **No hero stats, no gradients, no cards** — the layout is a tool, not a dashboard.

**What was removed (Chanel's mirror):** An earlier idea included a prominent AI assistant panel as a fourth pane. It was removed from the default view and folded into a tool-window icon that opens on demand, so the main page stays focused on triage and reading.

## Implementation Notes

- Store the full palette as CSS variables in `src/styles/theme.css`.
- Map variables to Tailwind v4 `@theme inline` for utility classes.
- Use `react-resizable-panels` for pane sizing; persist widths in `uiStore`.
- Apply the serif treatment only to subject lines and reading-pane titles.
- Use React Aria Components for collection behaviors (Tree, GridList, ListBox) and keyboard navigation.
- Plugin injection points should align with the layout regions defined in the architecture spec.

## Prototype

See [`prototype/main-page.html`](./prototype/main-page.html) for a self-contained, interactive HTML/CSS prototype demonstrating the layout, theme toggle, density toggle, folder-pane collapse, and reading-pane position toggle.
