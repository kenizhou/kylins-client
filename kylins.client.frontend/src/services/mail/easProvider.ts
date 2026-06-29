// Ported from mailkit_arkts. License pending confirmation. See ATTRIBUTIONS.md.
//
// EAS provider — wraps the Rust `eas_*` Tauri commands so the rest of the
// frontend can talk to Exchange ActiveSync the same way it talks to IMAP.
// Each instance is tied to a single account; construct a new provider per
// account when the user switches.

import { invoke } from '@tauri-apps/api/core';
import type { Account } from '../../types';
import type { MailProvider, SyncResult } from './provider';

// ---------- Rust-facing types ----------

export interface RustEasConfig {
  url: string;
  username: string;
  password: string;
  protocol_version: string;
  device_id: string;
  device_type: string;
  user_agent: string;
  policy_key: string;
  accept_invalid_certs: boolean;
}

export interface EasFolder {
  server_id: string;
  parent_id: string;
  display_name: string;
  class: string;
  /** Raw EAS MS-ASFD Type byte (2=Inbox, 3=Drafts, ...). Optional: older
   *  payloads without it fall back to name-based role detection. */
  folder_type?: number;
}

export interface EasFolderSyncResult {
  sync_key: string;
  changes: EasFolder[];
  deletions: string[];
}

export interface EasAttachment {
  file_reference: string;
  display_name: string;
  content_id: string | null;
  is_inline: boolean;
  /** Optional: server may omit. Typed as number|null to match the Rust struct. */
  estimated_data_size: number | null;
  /** Optional EAS Method: 1=Normal, 5=EmbeddedMessage, 6=AttachOLE. */
  method: number | null;
  /** MIME content type, surfaced on ItemOperations fetch. */
  content_type: string | null;
  /** URL for externally-stored attachments. Rarely populated for mail. */
  content_location: string | null;
}

/**
 * EAS Sync item envelope. Mirrors the Rust `EasItem` struct
 * (`kylins.client.backend/src/eas/types.rs`) which is serialized to camelCase
 * via `#[serde(rename_all = "camelCase")]` and returned across the `eas_sync`
 * IPC boundary. The `class` field was dropped in Phase 3a Task 1 (the EAS
 * protocol carries class at the collection level, not per item) — callers that
 * need the class must track it from the originating `SyncRequest`.
 */
export interface EasItem {
  server_id: string;
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  date_received: string | null;
  read: boolean | null;
  flag: boolean | null;
  importance: number | null;
  body_html: string | null;
  body_text: string | null;
  body_truncated: boolean | null;
  preview: string | null;
  has_attachments: boolean;
  attachments: EasAttachment[];
  /** Raw opaque ConversationId bytes from the server. */
  conversation_id: number[] | null;
  is_draft: boolean | null;
  message_id: string | null;
}

export interface EasSyncResult {
  sync_key: string;
  added: EasItem[];
  updated: EasItem[];
  deleted_server_ids: string[];
  more_available: boolean;
}

export interface EasSyncRequest {
  collection_id: string;
  sync_key: string;
  class: string;
  window_size: number;
  filter_age_days: number;
  fetch_body: boolean;
}

export interface EasSendMailRequest {
  mime_base64: string;
  save_to_sent: boolean;
}

export interface EasSmartForwardRequest extends EasSendMailRequest {
  source_server_id: string;
  source_collection_id: string;
  replace_mime: boolean;
}

export interface EasSmartReplyRequest extends EasSendMailRequest {
  source_server_id: string;
  source_collection_id: string;
  replace_mime: boolean;
}

export interface EasItemOperationsFetchRequest {
  server_id: string;
  collection_id: string;
  file_reference: string | null;
}

export interface EasItemOperationsFetchResult {
  status: number;
  data: string | null;
  content_type: string | null;
}

export interface EasGetItemEstimateRequest {
  collection_id: string;
  sync_key: string;
  class: string;
  filter_age_days: number;
}

export interface EasGetItemEstimateResult {
  count: number;
  collection_id: string;
}

export interface EasPingCollection {
  collection_id: string;
  class: string;
}

export interface EasPingRequest {
  heartbeat_interval: number;
  monitored_collections: EasPingCollection[];
}

export interface EasPingResult {
  status: string;
}

export interface EasFolderCreateRequest {
  parent_id: string;
  display_name: string;
  class: string;
}

export interface EasFolderUpdateRequest {
  server_id: string;
  parent_id: string | null;
  display_name: string | null;
}

export interface EasFolderDeleteRequest {
  server_id: string;
}

// ---------- Provider ----------

export function easConfigFromAccount(account: Account): RustEasConfig {
  if (!account.easUrl) {
    throw new Error(`Account ${account.email} has no eas_url configured`);
  }
  if (!account.easDeviceId) {
    throw new Error(`Account ${account.email} has no eas_device_id`);
  }
  return {
    url: account.easUrl,
    username: account.imapUsername ?? account.email,
    password: account.imapPassword ?? '',
    protocol_version: account.easProtocolVersion ?? '16.1',
    device_id: account.easDeviceId,
    device_type: 'KylinsMail',
    user_agent: 'KylinsMail/1.0',
    policy_key: account.easPolicyKey ?? '0',
    accept_invalid_certs: account.acceptInvalidCerts ?? false,
  };
}

export class EasProvider implements MailProvider {
  readonly id = 'eas';

  constructor(private _account: Account) {}

  private get cfg(): RustEasConfig {
    return easConfigFromAccount(this._account);
  }

  /** Probe connection + credentials by issuing a trivial FolderSync with sync_key "0". */
  async connect(): Promise<void> {
    const result = await invoke<EasFolderSyncResult>('eas_folder_sync', {
      config: this.cfg,
      syncKey: '0',
    });
    if (!result.sync_key || result.sync_key === '0') {
      throw new Error('FolderSync returned invalid sync key — credentials may be wrong');
    }
  }

  async folderSync(syncKey: string): Promise<EasFolderSyncResult> {
    return invoke<EasFolderSyncResult>('eas_folder_sync', {
      config: this.cfg,
      syncKey,
    });
  }

  async sync(request: EasSyncRequest): Promise<EasSyncResult> {
    return invoke<EasSyncResult>('eas_sync', {
      config: this.cfg,
      request,
    });
  }

  async sendMail(request: EasSendMailRequest): Promise<number> {
    return invoke<number>('eas_send_mail', {
      config: this.cfg,
      request,
    });
  }

  async smartForward(request: EasSmartForwardRequest): Promise<number> {
    return invoke<number>('eas_smart_forward', {
      config: this.cfg,
      request,
    });
  }

  async smartReply(request: EasSmartReplyRequest): Promise<number> {
    return invoke<number>('eas_smart_reply', {
      config: this.cfg,
      request,
    });
  }

  async itemOperations(
    request: EasItemOperationsFetchRequest,
  ): Promise<EasItemOperationsFetchResult> {
    return invoke<EasItemOperationsFetchResult>('eas_item_operations', {
      config: this.cfg,
      request,
    });
  }

  async getItemEstimate(request: EasGetItemEstimateRequest): Promise<EasGetItemEstimateResult> {
    return invoke<EasGetItemEstimateResult>('eas_get_item_estimate', {
      config: this.cfg,
      request,
    });
  }

  async ping(request: EasPingRequest): Promise<EasPingResult> {
    return invoke<EasPingResult>('eas_ping', {
      config: this.cfg,
      request,
    });
  }

  async folderCreate(request: EasFolderCreateRequest): Promise<[number, string | null]> {
    return invoke<[number, string | null]>('eas_folder_create', {
      config: this.cfg,
      request,
    });
  }

  async folderDelete(request: EasFolderDeleteRequest): Promise<[number, string | null]> {
    return invoke<[number, string | null]>('eas_folder_delete', {
      config: this.cfg,
      request,
    });
  }

  async folderUpdate(request: EasFolderUpdateRequest): Promise<[number, string | null]> {
    return invoke<[number, string | null]>('eas_folder_update', {
      config: this.cfg,
      request,
    });
  }

  /** Simplified MailProvider contract — full sync via FolderSync + Sync. */
  async syncFolder(folderId: string): Promise<SyncResult> {
    const syncResult = await this.sync({
      collection_id: folderId,
      sync_key: '0',
      class: 'Email',
      window_size: 50,
      filter_age_days: 0,
      fetch_body: true,
    });
    return {
      added: syncResult.added.length,
      updated: syncResult.updated.length,
      deleted: syncResult.deleted_server_ids.length,
    };
  }
}
