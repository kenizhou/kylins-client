# Kylins Client — Brand Guidelines v1.0

> Last updated: 2026-07-03
> Status: Active
> Theme: Inbox Professional

## Quick Reference

| Element         | Value                                   |
| --------------- | --------------------------------------- |
| Primary Color   | #2563EB                                 |
| Secondary Color | #3B82F6                                 |
| Accent Color    | #DC2626                                 |
| Primary Font    | Plus Jakarta Sans                       |
| Mono Font       | JetBrains Mono / system monospace       |
| Voice           | Professional, Helpful, Clear, Confident |

---

## 1. Brand Concept

**Kylins Client** is a desktop email client for professionals who need a focused, reliable, and calm workspace. The brand expression is intentionally understated: confidence comes from clarity, not decoration.

**Inbox Professional** combines the trustworthiness of classic productivity tools with a modern, approachable finish. The palette is built around a stable action blue, with red reserved for urgency and destructive actions. Typography is clean and highly legible at small UI sizes.

---

## 2. Color Palette

### Primary Colors

| Name          | Hex     | RGB             | Usage                                                |
| ------------- | ------- | --------------- | ---------------------------------------------------- |
| Primary Blue  | #2563EB | rgb(37,99,235)  | Primary actions, links, selected states, focus rings |
| Primary Dark  | #1D4ED8 | rgb(29,78,216)  | Hover states, pressed states                         |
| Primary Light | #60A5FA | rgb(96,165,250) | Dark-mode primary, highlights                        |

### Secondary Colors

| Name             | Hex     | RGB             | Usage                                    |
| ---------------- | ------- | --------------- | ---------------------------------------- |
| Bright Blue      | #3B82F6 | rgb(59,130,246) | Secondary actions, info badges, emphasis |
| Bright Blue Dark | #2563EB | rgb(37,99,235)  | Secondary hover                          |

### Accent Colors

| Name              | Hex     | RGB            | Usage                                     |
| ----------------- | ------- | -------------- | ----------------------------------------- |
| Priority Red      | #DC2626 | rgb(220,38,38) | Urgent items, destructive actions, errors |
| Priority Red Dark | #B91C1C | rgb(185,28,28) | Destructive hover                         |

### Neutral Palette

| Name           | Hex     | RGB              | Usage                                |
| -------------- | ------- | ---------------- | ------------------------------------ |
| Background     | #FFFFFF | rgb(255,255,255) | Page backgrounds                     |
| Surface        | #F1F5F9 | rgb(241,245,249) | Cards, panels, secondary surfaces    |
| Text Primary   | #0F172A | rgb(15,23,42)    | Headings, primary text               |
| Text Secondary | #64748B | rgb(100,116,139) | Captions, muted labels, placeholders |
| Border         | #E2E8F0 | rgb(226,232,240) | Dividers, input borders, separators  |

### Semantic Colors

| State   | Hex     | Usage                                                   |
| ------- | ------- | ------------------------------------------------------- |
| Success | #22C55E | Positive confirmations, sent status, connected accounts |
| Warning | #F59E0B | Pending states, low-priority alerts                     |
| Error   | #DC2626 | Errors, destructive actions                             |
| Info    | #3B82F6 | Informational tips, hints                               |

### Accessibility

- Text Primary on Background: 12.5:1 (AAA)
- Text Secondary on Background: 4.6:1 (AA)
- Primary Blue on Background: 4.6:1 (AA)
- Priority Red on Background: 5.3:1 (AA)
- All interactive elements meet WCAG 2.1 AA minimums.

---

## 3. Typography

### Font Stack

```css
--font-heading:
  "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui,
  sans-serif;
--font-body:
  "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui,
  sans-serif;
--font-mono:
  "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
  monospace;
```

Plus Jakarta Sans is self-hosted via `@fontsource/plus-jakarta-sans` so the app remains fully offline-capable.

### Type Scale

| Element    | Size | Weight | Line Height |
| ---------- | ---- | ------ | ----------- |
| H1         | 28px | 700    | 1.2         |
| H2         | 22px | 600    | 1.25        |
| H3         | 18px | 600    | 1.3         |
| H4         | 16px | 600    | 1.35        |
| Body       | 14px | 400    | 1.5         |
| Body Large | 16px | 400    | 1.5         |
| Small      | 12px | 400    | 1.4         |
| Caption    | 11px | 500    | 1.3         |

### Typography Rules

- Use `font-variant-numeric: tabular-nums` for timestamps, message counts, and file sizes.
- Prefer sentence case for labels and buttons.
- Use ellipsis (`…`) for truncation, never three periods (`...`).

---

## 4. Logo Usage

### Variants

| Variant         | File                       | Use Case                       |
| --------------- | -------------------------- | ------------------------------ |
| Full Horizontal | `logo-full-horizontal.svg` | About dialog, marketing        |
| Stacked         | `logo-stacked.svg`         | Splash screen, square contexts |
| Icon Only       | `logo-icon.svg`            | Favicon, taskbar, tray         |
| Monochrome      | `logo-mono.svg`            | Limited-color contexts         |

> Assets are not yet finalized; use the wordmark "Kylins" in `--font-heading` as a placeholder.

### Clear Space

Minimum clear space around the logo equals the height of the icon mark.

### Minimum Size

| Context             | Minimum Width |
| ------------------- | ------------- |
| Digital — Full Logo | 120px         |
| Digital — Icon      | 20px          |

### Don'ts

- Don't rotate, skew, or stretch the logo.
- Don't recolor outside the approved palette.
- Don't add shadows, glows, or 3D effects.
- Don't place on busy backgrounds without sufficient contrast.

---

## 5. Voice & Tone

### Brand Personality

| Trait            | Description                                             |
| ---------------- | ------------------------------------------------------- |
| **Professional** | Competent and reliable; every word earns trust.         |
| **Helpful**      | Action-oriented, anticipating what the user needs next. |
| **Clear**        | Plain language; no jargon, no fluff.                    |
| **Confident**    | Direct without being arrogant.                          |

### Voice Chart

| Trait        | We Are                 | We Are Not            |
| ------------ | ---------------------- | --------------------- |
| Professional | Competent, respectful  | Stuffy, corporate     |
| Helpful      | Supportive, empowering | Patronizing           |
| Clear        | Direct, concise        | Vague, wordy          |
| Confident    | Assured, trustworthy   | Arrogant, overselling |

### Tone by Context

| Context             | Tone                   | Example                                                              |
| ------------------- | ---------------------- | -------------------------------------------------------------------- |
| Onboarding          | Warm, instructive      | "Connect your first account to get started."                         |
| Error messages      | Calm, solution-focused | "We couldn't reach the server. Check your connection and try again." |
| Success             | Brief, factual         | "Message sent."                                                      |
| Empty states        | Helpful, guiding       | "No unread messages. Select a folder to keep going."                 |
| Destructive actions | Direct, cautious       | "Delete this message? This can't be undone."                         |

### Prohibited Terms

| Avoid         | Reason                                           |
| ------------- | ------------------------------------------------ |
| Revolutionary | Overused                                         |
| Best-in-class | Vague claim                                      |
| Seamless      | Overused                                         |
| Synergy       | Corporate jargon                                 |
| Leverage      | Use "use" instead                                |
| AI-powered    | Unless describing a specific, verifiable feature |

---

## 6. Imagery Guidelines

### Photography Style

- **Lighting:** Natural, soft, even lighting.
- **Subjects:** Real people in focused work scenarios; avoid generic stock poses.
- **Color treatment:** Muted, cool neutrals with subtle blue accent matching the palette.
- **Composition:** Clean, centered subjects with generous negative space.

### Illustrations

- Style: Flat, minimal, 2D vector.
- Colors: Brand palette only.
- Line weight: 1.5px stroke for icons; 2px for spot illustrations.
- Corners: 4px rounded corners on shapes.

### Icons

- Family: Hugeicons (outline style).
- Base grid: 24px.
- Stroke: 1.5px consistent.
- Corner radius: 2px.
- Fill: None (outline only) unless the icon is a status indicator.

---

## 7. Design Components

### Buttons

| Type        | Background  | Text    | Border      | Border Radius |
| ----------- | ----------- | ------- | ----------- | ------------- |
| Primary     | #2563EB     | #FFFFFF | none        | 6px           |
| Secondary   | transparent | #2563EB | 1px #2563EB | 6px           |
| Tertiary    | transparent | #64748B | none        | 6px           |
| Destructive | #DC2626     | #FFFFFF | none        | 6px           |

### Spacing Scale

| Token | Value | Usage                      |
| ----- | ----- | -------------------------- |
| xs    | 4px   | Tight internal padding     |
| sm    | 8px   | Compact element gaps       |
| md    | 12px  | Standard component padding |
| lg    | 16px  | Section gaps               |
| xl    | 24px  | Major section dividers     |
| 2xl   | 32px  | Page-level spacing         |

### Border Radius

| Element          | Radius |
| ---------------- | ------ |
| Buttons          | 6px    |
| Inputs           | 6px    |
| Cards / Panels   | 8px    |
| Modals / Dialogs | 8px    |
| Pills / Tags     | 9999px |

---

## 8. AI Image Generation

### Base Prompt Template

```
Professional desktop email client UI, cool blue-gray neutral palette with #2563EB accent blue and #DC2626 priority red, flat minimal design, soft natural lighting, clean focused composition, generous whitespace, modern productivity software aesthetic, no heavy shadows or 3D effects.
```

### Style Keywords

| Category    | Keywords                                       |
| ----------- | ---------------------------------------------- |
| Lighting    | soft, even, natural                            |
| Mood        | professional, calm, focused, trustworthy       |
| Composition | centered, minimal, generous whitespace         |
| Treatment   | flat, 2D, clean lines, low saturation neutrals |
| Aesthetic   | modern productivity, enterprise SaaS           |

### Visual Mood Descriptors

- Calm and focused workspace
- Trustworthy enterprise tool
- Clean, modern productivity interface

### Visual Don'ts

| Avoid                     | Reason                            |
| ------------------------- | --------------------------------- |
| Heavy gradients           | Conflicts with flat design system |
| 3D skeuomorphism          | Dated and inconsistent            |
| Neon or saturated accents | Breaks calm, professional mood    |
| Busy backgrounds          | Hurts readability and focus       |
| Emoji or raster icons     | Must match vector icon system     |

### Example Prompts

**Hero Banner:**

```
A focused professional working at a clean desk with a large monitor showing a modern blue-gray email application, soft natural window light, minimal background, cool neutral tones with subtle #2563EB highlights, photorealistic, shallow depth of field.
```

**Feature Illustration:**

```
Flat vector illustration of an email inbox interface, blue #2563EB primary actions, red #DC2626 urgent badge, cool gray neutrals, 1.5px outline icons, generous whitespace, modern SaaS style.
```

---

## 9. Changelog

| Version | Date       | Changes                                                               |
| ------- | ---------- | --------------------------------------------------------------------- |
| 1.0     | 2026-07-03 | Initial brand guidelines for Kylins Client — Inbox Professional theme |
