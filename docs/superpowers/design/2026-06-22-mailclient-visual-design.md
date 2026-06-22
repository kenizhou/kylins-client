# Mailclient Visual Design Direction

## Subject, Audience, and Job

- **Subject:** A desktop email client built with Tauri, React, and SQLite.
- **Audience:** Knowledge workers who live in email — managers, engineers, freelancers — and want Outlook-level power with IDE-like density and AI assistance.
- **Single job of the main view:** Help the user triage, read, and act on messages as fast as possible without feeling cluttered.

## Constraints from the Brief

- Layout structure follows **IntelliJ IDEA New UI** (simplified header, icon-first tool-window bars, compact density, draggable panes) and **Outlook 2024** (folder pane, message list, reading pane, optional inspector).
- Primary color is locked to the CMMP blue palette:
  - Light: `oklch(0.546 0.245 262.881)` ~ #3b82f6
  - Dark: `oklch(0.707 0.165 254.624)` ~ #60a5fa
- UI built with React Aria Components + Tailwind CSS v4.
- Must support plugins, themes, and AI-native features.

## Palette

| Token | Light | Dark | Usage |
|---|---|---|---|
| `background` | `#ffffff` | `#111827` | Main app background |
| `foreground` | `#111827` | `#f9fafb` | Primary text |
| `card` | `#ffffff` | `#1f2937` | Pane backgrounds, headers |
| `muted` | `#f3f4f6` | `#27354f` | Status bar, inactive rows, hover |
| `muted-foreground` | `#4b5563` | `#9ca3af` | Secondary text, timestamps |
| `primary` | `#3b82f6` | `#60a5fa` | Selected items, focus rings, active account |
| `primary-foreground` | `#ffffff` | `#111827` | Text on primary backgrounds |
| `accent` | `#eff6ff` | `#1e3a8a` | Hover highlights, subtle badges |
| `accent-foreground` | `#1e40af` | `#bfdbfe` | Text on accent backgrounds |
| `destructive` | `#dc2626` | `#f87171` | Delete, spam, errors |
| `warning` | `#f59e0b` | `#fbbf24` | Follow-up, reminders |
| `success` | `#10b981` | `#34d399` | Sent, synced, healthy |
| `border` | `#e5e7eb` | `#374151` | Dividers, pane borders |
| `ring` | `#3b82f6` | `#60a5fa` | Focus rings |

## Typography

- **UI / body:** `Geist` or `Inter` — clean, dense, excellent at small sizes for toolbars and lists.
- **Reading pane body:** `Inter` or system sans — maximum readability for long-form email.
- **Subject lines / display:** `Source Serif 4` (or `Merriweather`) — the deliberate risk. A serif for message subjects and reading-pane titles gives the app an editorial, "important correspondence" feel and breaks the generic sans-serif default of every other email client.
- **Code / metadata:** `Geist Mono` or `JetBrains Mono` for timestamps, account IDs, and AI-generated structured output.

Type scale:
- `xs` (11px): captions, timestamps, status bar
- `sm` (13px): list rows, folder names, button labels
- `base` (14px): body text, reading pane
- `lg` (16px): pane headers, section labels
- `xl` (20px): selected subject line
- `2xl` (24px): reading pane subject

## Layout Concept

```
┌─────────────────────────────────────────────────────────────────┐
│  ≡  Mailclient    [Search]              [New mail] [⚙] [👤]    │  ← HeaderBar (IntelliJ simplified)
├───┬─────────────────────────────────────────────────────────────┤
│   │  Folders ▾  │  Focused  Other ▾  │  Coral Gables Project... │
│ ◆ │  Inbox    9 │  ▶ Kevin Sturgis                   9:30 AM    │  ← PaneHeaders
│ 📅│  Sent        │  ▶ Cecil Folk                      1:23 PM    │
│ 👤│  Drafts      │  ▶ Lydia Bauer                    12:55 PM    │
│ 📎│              │                                              │
│ ⚙️│              │                                              │
├───┴──────────────┴──────────────────────┬───────────────────────┤
│ Status: Synced · 3 accounts             │  [AI] [Reply] [Forward]│  ← StatusBar
└─────────────────────────────────────────┴───────────────────────┘
```

- **Tool-window bar:** 44px wide vertical strip on the left with large 20px icons; labels via tooltips.
- **Folder pane:** 240px default, collapsible to 44px mini-mode.
- **Message list:** 320px default, resizable.
- **Reading pane:** remaining space; subject in serif at top.
- **Status bar:** 24px high, low-contrast text.

## The Signature Element: The Thread Ribbon

A vertical 3px line on the left edge of each message row and reading-pane message that uses color to encode conversation state:

- **Blue (`primary`)** — unread message in the current thread.
- **Gray (`border`)** — read message.
- **Amber (`warning`)** — message flagged for follow-up.
- **Green (`success`)** — message from a VIP/safe sender.

In the reading pane, this line extends into a subtle timeline showing the thread's back-and-forth, making email feel like a tracked conversation rather than a flat list. This is the one aesthetic risk: it introduces color-coding most clients reserve for flags, but here it becomes the primary way the app communicates "what needs attention."

## Density Modes

- **Compact:** 28px list rows, 32px pane headers, 10px side padding. For power users.
- **Comfortable:** 40px list rows, 40px pane headers, 16px side padding. For laptops and tablet-like use.

## Motion

- Pane collapse/expand: 150ms ease-out width transition.
- Theme switch: 100ms color transition on CSS variables.
- Message selection: instant background swap; no fade (snappiness is the priority).
- New mail indicator: a single subtle bounce on the Inbox icon, not a flashing badge.
- AI thinking state: a slow pulse on the AI tool-window icon, not a spinner in the middle of the screen.

## Accessibility

- All color-coded states have an additional shape or icon indicator.
- Keyboard focus rings use `ring` token with 2px offset.
- Reduced motion disables pane animations and timeline pulses.

## What Was Deliberately Avoided

- Warm cream + high-contrast serif (template #1).
- Near-black + acid-green accent (template #2).
- Broadsheet hairlines + zero radius (template #3).
- Big hero stats or gradient cards — this is a tool, not a landing page.

## Implementation Notes

- Store the full palette as CSS variables in `src/styles/theme.css`.
- Map variables to Tailwind v4 `@theme inline` for utility classes.
- Use `react-resizable-panels` for pane sizing; persist widths in `uiStore`.
- The serif subject treatment is applied only to subject lines and reading-pane titles; all interactive UI remains sans-serif for clarity.
