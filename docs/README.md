# Kylins Mail — Documentation

## Architecture & Design

| Document | Description |
|----------|-------------|
| [architecture.md](architecture.md) | System architecture overview |
| [comparison-report.md](comparison-report.md) | Comparison with Velo, Mailspring, Thunderbird |
| [design/](design/) | Visual design and main page design specs |
| [specs/](specs/) | Detailed technical specifications |

## Frontend

| Document | Description |
|----------|-------------|
| [message-list-incremental-update.md](frontend/message-list-incremental-update.md) | **Design**: incremental insert + in-place update for message list (flicker fix) |
| [composer-viewer-calendar-state-report.md](frontend/composer-viewer-calendar-state-report.md) | Composer, viewer, calendar component status |
| [folder-pane-enhancement-plan.md](frontend/folder-pane-enhancement-plan.md) | Folder pane UI enhancement plan |
| [message-list-loading-plan.md](frontend/message-list-loading-plan.md) | Message list loading strategy |

## Sync Engine

| Document | Description |
|----------|-------------|
| [mail-sync-engine-research.md](sync-engine/mail-sync-engine-research.md) | Research on IMAP/EAS sync approaches |
| [sync-engine-design.md](sync-engine/sync-engine-design.md) | Sync engine specification (phases, architecture) |
| [sync-engine-phase0.md](sync-engine/sync-engine-phase0.md) | Phase 0: baseline poll-based sync |
| [sync-engine-phase1.md](sync-engine/sync-engine-phase1.md) | Phase 1: mutations + offline queue |
| [sync-engine-phase2.md](sync-engine/sync-engine-phase2.md) | Phase 2: IDLE watcher + realtime strategy |
| [sync-engine-phase3-eas.md](sync-engine/sync-engine-phase3-eas.md) | Phase 3a: EAS WBXML sync |
| [sync-engine-phase3-gmail.md](sync-engine/sync-engine-phase3-gmail.md) | Phase 3b: Gmail API provider |
| [sync-engine-phase3-graph.md](sync-engine/sync-engine-phase3-graph.md) | Phase 3c: Microsoft Graph provider |
| [sync-engine-phase3-imap-qresync.md](sync-engine/sync-engine-phase3-imap-qresync.md) | Phase 3e: IMAP QRESYNC + CONDESTORE |
| [sync-engine-flag-move-detection.md](sync-engine/sync-engine-flag-move-detection.md) | **Bug**: flag changes / message moves not detected |
| [activesync-improvements-design.md](sync-engine/activesync-improvements-design.md) | ActiveSync improvements design |

## Composer / Viewer / Calendar

| Document | Description |
|----------|-------------|
| [composer-viewer-calendar-next-phases.md](composer-viewer-calendar/) | Next phases for composer/viewer/calendar |
| [composer-viewer-calendar-reference-design.md](composer-viewer-calendar/) | Reference design from Velo/Mailspring/Thunderbird |

## Contacts & Address Book

| Document | Description |
|----------|-------------|
| [contacts-addressbook-reference-design.md](contacts/) | Contacts and address book reference design |

## Account Setup

| Document | Description |
|----------|-------------|
| [account-setup.md](account-setup/) | Account setup flow design |
| [account-setup-design.md](account-setup/) | Account setup technical specification |

## Providers & Integration

| Document | Description |
|----------|-------------|
| [imap-improvement-plan.md](sync-engine/imap-improvement-plan.md) | IMAP client improvement plan |
| [inbox-zero-graph-gmail-provider-migration.md](sync-engine/inbox-zero-graph-gmail-provider-migration.md) | Gmail provider migration research |

## Protocols & References

| Directory | Description |
|-----------|-------------|
| [RFC/](RFC/) | IMAP RFC 9051 |
| [Exchange/](Exchange/) | MS Exchange ActiveSync protocol PDFs |
