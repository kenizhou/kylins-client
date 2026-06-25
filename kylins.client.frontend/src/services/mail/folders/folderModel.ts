// Canonical, source-agnostic folder model. The folder pane, stores, and the
// label service speak ONLY this type — never the raw IMAP/EAS/Graph wire
// formats. Per-provider shapes are normalized into MailFolder by the adapters
// in adapters.ts. Role mapping is ported from mailkit_arkts (the origin of our
// EAS provider); see ATTRIBUTIONS.md.

export type FolderSource = 'imap' | 'gmail' | 'eas' | 'graph' | 'local';

export type FolderRole =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'junk'
  | 'outbox'
  | 'archive'
  | 'flagged'
  | 'all'
  | 'important'
  | 'starred';

/**
 * Coarse folder class. EAS and Graph return non-mail special folders (Tasks,
 * Calendar, Contacts, Notes) in the same hierarchy listing; this lets the mail
 * folder pane filter them out without dropping them from the store.
 */
export type MailFolderClass = 'mail' | 'tasks' | 'calendar' | 'contacts' | 'notes';

export interface MailFolder {
  /** Internal id (labels.id). Stable across re-syncs. */
  id: string;
  accountId: string;
  source: FolderSource;
  /** Canonical special-folder role, or null for a user-created folder. */
  role: FolderRole | null;
  /** Display name (provider display name, decoded/trimmed). */
  name: string;
  /**
   * Native parent id (EAS parent_id / Graph parentFolderId / IMAP parent path).
   * Resolved to a sibling folder via remoteId at render time. null = top-level.
   */
  parentId: string | null;
  /** Provider-native folder id (EAS server_id / Graph id / IMAP raw_path). */
  remoteId: string;
  /** IMAP hierarchy delimiter (e.g. "/" or "."). null for non-IMAP sources. */
  delimiter: string | null;
  unreadCount: number;
  totalCount: number;
  sortOrder: number;
  visible: boolean;
  /** Full display path "a/b/c" when known. */
  hierarchicalName: string | null;
  mailClass: MailFolderClass;
}

/** Fixed display order for system folders within an account. */
export const SYSTEM_ROLE_ORDER: FolderRole[] = [
  'inbox',
  'starred',
  'important',
  'drafts',
  'sent',
  'junk',
  'archive',
  'trash',
  'outbox',
  'all',
  'flagged',
];

/** Sort key: system roles by canonical order, user folders (null) last. */
export function roleOrderIndex(role: FolderRole | null): number {
  if (role === null) return SYSTEM_ROLE_ORDER.length;
  const idx = SYSTEM_ROLE_ORDER.indexOf(role);
  return idx === -1 ? SYSTEM_ROLE_ORDER.length : idx;
}
