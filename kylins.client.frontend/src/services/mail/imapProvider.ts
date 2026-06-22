// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

import { invoke } from '@tauri-apps/api/core';
import type {
  Account,
  ImapConfig,
  ImapFolder,
  ImapFetchResult,
  ImapFolderSearchResult,
  ImapFolderStatus,
  ImapFolderSyncResult,
  ImapMessage,
  DeltaCheckRequest,
  DeltaCheckResult,
} from '../../types';
import type { MailProvider, SyncResult } from './provider';

interface RustImapConfig {
  host: string;
  port: number;
  security: string;
  username: string;
  password: string;
  auth_method: string;
  accept_invalid_certs: boolean;
}

function toRustConfig(account: Account): RustImapConfig {
  return {
    host: account.imapHost ?? '',
    port: account.imapPort ?? 993,
    security: account.imapSecurity ?? 'tls',
    username: account.imapUsername ?? account.email,
    password: account.imapPassword ?? '',
    auth_method: account.authMethod ?? 'password',
    accept_invalid_certs: account.acceptInvalidCerts ?? false,
  };
}

// Re-export the Rust struct type for callers that need to build one directly
export type { RustImapConfig as ImapConfig };

export class ImapProvider implements MailProvider {
  readonly id = 'imap';

  constructor(private _account: Account) {}

  async connect(): Promise<void> {
    const result = await invoke<string>('imap_test_connection', {
      config: toRustConfig(this._account),
    });
    if (!result.includes('Connected successfully')) {
      throw new Error(result);
    }
  }

  async listFolders(): Promise<ImapFolder[]> {
    return invoke<ImapFolder[]>('imap_list_folders', {
      config: toRustConfig(this._account),
    });
  }

  async fetchMessages(folder: string, uids: number[]): Promise<ImapFetchResult> {
    return invoke<ImapFetchResult>('imap_fetch_messages', {
      config: toRustConfig(this._account),
      folder,
      uids,
    });
  }

  async fetchNewUids(folder: string, sinceUid: number): Promise<number[]> {
    return invoke<number[]>('imap_fetch_new_uids', {
      config: toRustConfig(this._account),
      folder,
      sinceUid,
    });
  }

  async searchAllUids(folder: string): Promise<number[]> {
    return invoke<number[]>('imap_search_all_uids', {
      config: toRustConfig(this._account),
      folder,
    });
  }

  async fetchMessageBody(folder: string, uid: number): Promise<ImapMessage> {
    return invoke<ImapMessage>('imap_fetch_message_body', {
      config: toRustConfig(this._account),
      folder,
      uid,
    });
  }

  async fetchRawMessage(folder: string, uid: number): Promise<string> {
    return invoke<string>('imap_fetch_raw_message', {
      config: toRustConfig(this._account),
      folder,
      uid,
    });
  }

  async setFlags(folder: string, uids: number[], flags: string[], add: boolean): Promise<void> {
    await invoke('imap_set_flags', {
      config: toRustConfig(this._account),
      folder,
      uids,
      flags,
      add,
    });
  }

  async moveMessages(folder: string, uids: number[], destination: string): Promise<void> {
    await invoke('imap_move_messages', {
      config: toRustConfig(this._account),
      folder,
      uids,
      destination,
    });
  }

  async deleteMessages(folder: string, uids: number[]): Promise<void> {
    await invoke('imap_delete_messages', {
      config: toRustConfig(this._account),
      folder,
      uids,
    });
  }

  async getFolderStatus(folder: string): Promise<ImapFolderStatus> {
    return invoke<ImapFolderStatus>('imap_get_folder_status', {
      config: toRustConfig(this._account),
      folder,
    });
  }

  async fetchAttachment(folder: string, uid: number, partId: string): Promise<string> {
    return invoke<string>('imap_fetch_attachment', {
      config: toRustConfig(this._account),
      folder,
      uid,
      partId,
    });
  }

  async appendMessage(folder: string, rawMessage: string, flags?: string): Promise<void> {
    await invoke('imap_append_message', {
      config: toRustConfig(this._account),
      folder,
      flags: flags ?? null,
      rawMessage,
    });
  }

  async searchFolder(folder: string, sinceDate?: string): Promise<ImapFolderSearchResult> {
    return invoke<ImapFolderSearchResult>('imap_search_folder', {
      config: toRustConfig(this._account),
      folder,
      sinceDate: sinceDate ?? null,
    });
  }

  async syncFolderBatched(
    folder: string,
    batchSize: number,
    sinceDate?: string,
  ): Promise<ImapFolderSyncResult> {
    return invoke<ImapFolderSyncResult>('imap_sync_folder', {
      config: toRustConfig(this._account),
      folder,
      batchSize,
      sinceDate: sinceDate ?? null,
    });
  }

  async deltaCheck(folders: DeltaCheckRequest[]): Promise<DeltaCheckResult[]> {
    return invoke<DeltaCheckResult[]>('imap_delta_check', {
      config: toRustConfig(this._account),
      folders,
    });
  }

  async syncFolder(folderId: string): Promise<SyncResult> {
    const result = await this.syncFolderBatched(folderId, 50);
    return {
      added: result.messages.length,
      updated: 0,
      deleted: 0,
    };
  }
}

export function imapConfigFromAccount(account: Account): ImapConfig {
  return toRustConfig(account);
}
