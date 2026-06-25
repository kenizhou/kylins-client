// Per-provider folder source adapters. Each adapter normalizes one provider's
// raw wire format into the canonical MailFolder, encapsulating role resolution,
// parent/remote id extraction, and count sourcing. The rest of the app never
// sees the provider shapes — adding a new provider (e.g. Outlook Graph) means
// shipping one adapter here plus its backend, with no changes to the store or
// folder pane.

import type { ImapFolder, MailProvider } from '../../../types';
import type { EasFolder } from '../easProvider';
import type { FolderRole, FolderSource, MailFolder, MailFolderClass } from './folderModel';
import {
  easClassOf,
  roleFromEasType,
  roleFromGraphWellKnown,
  roleFromGmailId,
  roleFromNameFallback,
  roleFromSpecialUse,
} from './folderRoles';

export interface FolderSourceAdapter<R> {
  readonly source: FolderSource;
  /** Convert a raw provider folder descriptor into a canonical MailFolder. */
  normalize(raw: R, accountId: string): MailFolder;
}

// ---- Provider-native resource shapes (for providers without a backend yet) ----

/** Microsoft Graph mailFolder resource (subset). No backend exists yet. */
export interface GraphMailFolderResource {
  id: string;
  displayName: string;
  parentFolderId?: string | null;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
  wellKnownName?: string | null;
}

/** Gmail API Label resource (subset). No folder-list sync exists yet. */
export interface GmailLabelResource {
  id: string; // "INBOX", "SENT", "Label_1", ...
  name: string;
  type?: 'system' | 'user';
  labelListVisibility?: 'labelShow' | 'labelHide' | string;
  messagesTotal?: number;
  messagesUnread?: number;
}

// ---- Helpers ----

/** Deterministic internal id so re-syncs upsert the same row. */
function makeId(accountId: string, remoteId: string): string {
  return `${accountId}:${remoteId}`;
}

/** First non-null candidate — lets adapters chain type → name fallback. */
function firstRole(...candidates: Array<FolderRole | null>): FolderRole | null {
  for (const c of candidates) {
    if (c) return c;
  }
  return null;
}

/** IMAP parent path = everything before the last delimiter. */
function parentPathOf(path: string, delimiter: string | null | undefined): string | null {
  if (!path || !delimiter) return null;
  const idx = path.lastIndexOf(delimiter);
  if (idx <= 0) return null;
  return path.slice(0, idx);
}

function mailClassFromBackendClass(cls: string | null | undefined): MailFolderClass {
  switch ((cls ?? '').toLowerCase()) {
    case 'tasks':
      return 'tasks';
    case 'calendar':
      return 'calendar';
    case 'contacts':
      return 'contacts';
    case 'notes':
      return 'notes';
    default:
      return 'mail';
  }
}

// ---- Adapters ----

export const imapFolderAdapter: FolderSourceAdapter<ImapFolder> = {
  source: 'imap',
  normalize(raw, accountId) {
    const role = firstRole(
      roleFromSpecialUse(raw.special_use),
      roleFromNameFallback(raw.name),
      roleFromNameFallback(raw.path),
    );
    return {
      id: makeId(accountId, raw.raw_path || raw.path),
      accountId,
      source: 'imap',
      role,
      name: raw.name || raw.path,
      parentId: parentPathOf(raw.path, raw.delimiter),
      remoteId: raw.raw_path || raw.path,
      delimiter: raw.delimiter || null,
      unreadCount: raw.unseen ?? 0,
      totalCount: raw.exists ?? 0,
      sortOrder: 0,
      visible: true,
      hierarchicalName: raw.path || null,
      mailClass: 'mail',
    };
  },
};

export const easFolderAdapter: FolderSourceAdapter<EasFolder> = {
  source: 'eas',
  normalize(raw, accountId) {
    const role = firstRole(
      roleFromEasType(raw.folder_type),
      roleFromNameFallback(raw.display_name),
    );
    // Prefer the granular Type-byte class; fall back to the backend's collapsed class string.
    const typeClass = easClassOf(raw.folder_type);
    const mailClass: MailFolderClass =
      typeClass !== 'mail' ? typeClass : mailClassFromBackendClass(raw.class);
    return {
      id: makeId(accountId, raw.server_id),
      accountId,
      source: 'eas',
      role,
      name: raw.display_name || raw.server_id,
      parentId: raw.parent_id || null,
      remoteId: raw.server_id,
      delimiter: null,
      // EAS FolderSync does not return counts — they come from message sync.
      unreadCount: 0,
      totalCount: 0,
      sortOrder: 0,
      visible: true,
      hierarchicalName: null,
      mailClass,
    };
  },
};

export const graphFolderAdapter: FolderSourceAdapter<GraphMailFolderResource> = {
  source: 'graph',
  normalize(raw, accountId) {
    const role = firstRole(
      roleFromGraphWellKnown(raw.wellKnownName),
      roleFromNameFallback(raw.displayName),
    );
    return {
      id: makeId(accountId, raw.id),
      accountId,
      source: 'graph',
      role,
      name: raw.displayName || raw.id,
      parentId: raw.parentFolderId || null,
      remoteId: raw.id,
      delimiter: null,
      unreadCount: raw.unreadItemCount ?? 0,
      totalCount: raw.totalItemCount ?? 0,
      sortOrder: 0,
      visible: true,
      hierarchicalName: null,
      mailClass: 'mail',
    };
  },
};

export const gmailFolderAdapter: FolderSourceAdapter<GmailLabelResource> = {
  source: 'gmail',
  normalize(raw, accountId) {
    const role = firstRole(roleFromGmailId(raw.id), roleFromNameFallback(raw.name));
    const hidden = raw.labelListVisibility === 'labelHide';
    return {
      id: makeId(accountId, raw.id),
      accountId,
      source: 'gmail',
      role,
      name: raw.name || raw.id,
      parentId: null,
      remoteId: raw.id,
      delimiter: null,
      unreadCount: raw.messagesUnread ?? 0,
      totalCount: raw.messagesTotal ?? 0,
      sortOrder: 0,
      visible: !hidden,
      hierarchicalName: null,
      mailClass: 'mail',
    };
  },
};

/** Map an account's provider to its folder source. */
export function sourceFromProvider(provider: MailProvider): FolderSource {
  switch (provider) {
    case 'imap':
      return 'imap';
    case 'eas':
      return 'eas';
    case 'gmail_api':
      return 'gmail';
    default:
      return 'local';
  }
}

/**
 * Pick the adapter for an account provider. Used by sync to normalize raw
 * folder listings before persisting. Outlook Graph will plug in here once a
 * `graph` provider is added to MailProvider.
 */
export function pickAdapter(provider: MailProvider): FolderSourceAdapter<unknown> {
  switch (provider) {
    case 'imap':
      return imapFolderAdapter as FolderSourceAdapter<unknown>;
    case 'eas':
      return easFolderAdapter as FolderSourceAdapter<unknown>;
    case 'gmail_api':
      return gmailFolderAdapter as FolderSourceAdapter<unknown>;
    default:
      throw new Error(`No folder adapter for provider: ${provider as string}`);
  }
}
