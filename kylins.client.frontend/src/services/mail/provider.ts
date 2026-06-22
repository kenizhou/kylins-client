export interface SyncResult {
  added: number;
  updated: number;
  deleted: number;
}

export interface MailProvider {
  readonly id: string;
  connect(): Promise<void>;
  syncFolder(folderId: string): Promise<SyncResult>;
  sendMessage?(draft: unknown): Promise<void>;
}
