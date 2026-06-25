// Role resolution: map each provider's special-folder scheme into a single
// canonical FolderRole. EAS Type-byte mapping is ported from mailkit_arkts's
// convertActiveSyncTypeToFolderType (MS-ASFD FolderHierarchy:Type). IMAP maps
// RFC 6154 special-use flags. Graph maps mailFolder wellknownName. These are
// pure functions so the mapping tables are exhaustively unit-testable.

import type { FolderRole, MailFolderClass } from './folderModel';

/**
 * IMAP / Gmail special-use flag → role (RFC 6154). `\Inbox` is included for
 * completeness though servers usually signal Inbox by name rather than a flag.
 */
export function roleFromSpecialUse(flag: string | null | undefined): FolderRole | null {
  if (!flag) return null;
  switch (flag.toLowerCase()) {
    case '\\inbox':
      return 'inbox';
    case '\\sent':
      return 'sent';
    case '\\drafts':
      return 'drafts';
    case '\\trash':
      return 'trash';
    case '\\junk':
      return 'junk';
    case '\\archive':
      return 'archive';
    case '\\all':
      return 'all';
    case '\\flagged':
      return 'flagged';
    default:
      return null;
  }
}

/**
 * EAS MS-ASFD Type byte → role. Only the default mail folders carry a role;
 * user-created mail folders (1, 12), unknown (18), etc. return null and rely on
 * name fallback (e.g. Exchange "Junk E-mail", "Archive").
 */
export function roleFromEasType(typeByte: number | string | null | undefined): FolderRole | null {
  const t = toInt(typeByte);
  if (t === null) return null;
  switch (t) {
    case 2:
      return 'inbox';
    case 3:
      return 'drafts';
    case 4:
      return 'trash';
    case 5:
      return 'sent';
    case 6:
      return 'outbox';
    default:
      return null;
  }
}

/**
 * EAS Type byte → folder class. Non-mail default folders (Tasks/Calendar/
 * Contacts/Notes) and their user-created counterparts map off-mail so the pane
 * can hide them. Ported from mailkit_arkts + our backend folder_type_to_class.
 */
export function easClassOf(typeByte: number | string | null | undefined): MailFolderClass {
  const t = toInt(typeByte);
  if (t === null) return 'mail';
  if (t === 7 || t === 15) return 'tasks';
  if (t === 8 || t === 13) return 'calendar';
  if (t === 9 || t === 14) return 'contacts';
  if (t === 10 || t === 11 || t === 16 || t === 17) return 'notes';
  return 'mail';
}

/** Microsoft Graph mailFolder.wellKnownName → role. */
export function roleFromGraphWellKnown(name: string | null | undefined): FolderRole | null {
  if (!name) return null;
  switch (name.toLowerCase()) {
    case 'inbox':
      return 'inbox';
    case 'sentitems':
      return 'sent';
    case 'drafts':
      return 'drafts';
    case 'deleteditems':
      return 'trash';
    case 'junkemail':
      return 'junk';
    case 'archive':
      return 'archive';
    case 'outbox':
      return 'outbox';
    default:
      return null;
  }
}

const NAME_ROLE_MAP: Record<string, FolderRole> = {
  inbox: 'inbox',
  inboxes: 'inbox',
  sent: 'sent',
  'sent items': 'sent',
  'sent mail': 'sent',
  drafts: 'drafts',
  draft: 'drafts',
  trash: 'trash',
  deleted: 'trash',
  'deleted items': 'trash',
  bin: 'trash',
  spam: 'junk',
  junk: 'junk',
  'junk e-mail': 'junk',
  'junk email': 'junk',
  archive: 'archive',
  outbox: 'outbox',
  starred: 'starred',
  important: 'important',
  flagged: 'flagged',
  'all mail': 'all',
  all: 'all',
};

/** Last-resort role detection from a display name (case-insensitive). */
export function roleFromNameFallback(name: string | null | undefined): FolderRole | null {
  if (!name) return null;
  return NAME_ROLE_MAP[name.trim().toLowerCase()] ?? null;
}

/** Gmail system label id (e.g. "INBOX", "SENT", "Label_1") → role. */
export function roleFromGmailId(id: string | null | undefined): FolderRole | null {
  if (!id) return null;
  switch (id.toUpperCase()) {
    case 'INBOX':
      return 'inbox';
    case 'SENT':
      return 'sent';
    case 'DRAFT':
      return 'drafts';
    case 'TRASH':
      return 'trash';
    case 'SPAM':
      return 'junk';
    case 'IMPORTANT':
      return 'important';
    case 'STARRED':
      return 'starred';
    default:
      return null;
  }
}

function toInt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  return Number.isNaN(n) ? null : n;
}
