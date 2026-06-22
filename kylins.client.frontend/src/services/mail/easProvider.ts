import type { Account } from '../../types';
import type { MailProvider, SyncResult } from './provider';

export class EasProvider implements MailProvider {
  readonly id = 'eas';
  private _client: unknown;

  constructor(private _account: Account) {
    void this._account;
  }

  async connect(): Promise<void> {
    // TODO: integrate custom EAS library here
    this._client = null;
    void this._client;
  }

  async syncFolder(_folderId: string): Promise<SyncResult> {
    // TODO: implement via custom EAS library
    return { added: 0, updated: 0, deleted: 0 };
  }
}
