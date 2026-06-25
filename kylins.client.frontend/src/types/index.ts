// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

export type MailProvider = 'gmail_api' | 'imap' | 'eas';

export type SecurityMode = 'tls' | 'starttls' | 'none';

export type AuthMethod = 'password' | 'oauth2';

export interface ImapSettings {
  host: string;
  port: number;
  security: SecurityMode;
  username: string;
  password: string;
  authMethod: AuthMethod;
  acceptInvalidCerts?: boolean;
}

export interface SmtpSettings {
  host: string;
  port: number;
  security: SecurityMode;
  username: string;
  password: string;
  authMethod: AuthMethod;
  acceptInvalidCerts?: boolean;
}

export interface EasSettings {
  url: string;
  protocolVersion: string;
  deviceId: string;
  userAgent?: string;
  username: string;
  password: string;
}

export interface Account {
  id: string;
  email: string;
  displayName?: string;
  accountLabel?: string;
  avatarUrl?: string;
  provider: MailProvider;
  setupProviderId?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  historyId?: string;
  lastSyncAt?: number;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  // IMAP/SMTP provider fields (migration 14-16, 23)
  imapHost?: string;
  imapPort?: number;
  imapSecurity?: SecurityMode;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: SecurityMode;
  authMethod?: AuthMethod;
  imapPassword?: string;
  imapUsername?: string;
  oauthProvider?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  acceptInvalidCerts?: boolean;
  // EAS fields (migration 26)
  easUrl?: string;
  easProtocolVersion?: string;
  easDeviceId?: string;
  easPolicyKey?: string;
  easUserAgent?: string;
}

export interface DbAccountRow {
  id: string;
  email: string;
  display_name?: string | null;
  account_label?: string | null;
  avatar_url?: string | null;
  provider: string;
  setup_provider_id?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: number | null;
  history_id?: string | null;
  last_sync_at?: number | null;
  is_active: number;
  is_default: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
  // IMAP/SMTP
  imap_host?: string | null;
  imap_port?: number | null;
  imap_security?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_security?: string | null;
  auth_method?: string | null;
  imap_password?: string | null;
  imap_username?: string | null;
  oauth_provider?: string | null;
  oauth_client_id?: string | null;
  oauth_client_secret?: string | null;
  accept_invalid_certs?: number | null;
  // EAS
  eas_url?: string | null;
  eas_protocol_version?: string | null;
  eas_device_id?: string | null;
  eas_policy_key?: string | null;
  eas_user_agent?: string | null;
}

export interface ImapFolder {
  path: string;
  raw_path: string;
  name: string;
  delimiter: string;
  special_use: string | null;
  exists: number;
  unseen: number;
}

export interface ImapAttachment {
  part_id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string | null;
  is_inline: boolean;
}

export interface ImapMessage {
  uid: number;
  folder: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  reply_to: string | null;
  subject: string | null;
  date: number;
  is_read: boolean;
  is_starred: boolean;
  is_draft: boolean;
  body_html: string | null;
  body_text: string | null;
  snippet: string | null;
  raw_size: number;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  auth_results: string | null;
  attachments: ImapAttachment[];
}

export interface ImapFolderStatus {
  uidvalidity: number;
  uidnext: number;
  exists: number;
  unseen: number;
  highest_modseq: number | null;
}

export interface ImapFetchResult {
  messages: ImapMessage[];
  folder_status: ImapFolderStatus;
}

export interface ImapFolderSyncResult {
  uids: number[];
  messages: ImapMessage[];
  folder_status: ImapFolderStatus;
}

export interface ImapFolderSearchResult {
  uids: number[];
  folder_status: ImapFolderStatus;
}

export interface DeltaCheckRequest {
  folder: string;
  last_uid: number;
  uidvalidity: number;
}

export interface DeltaCheckResult {
  folder: string;
  uidvalidity: number;
  new_uids: number[];
  uidvalidity_changed: boolean;
}

export interface SmtpSendResult {
  success: boolean;
  message: string;
}

export interface OAuthResult {
  code: string;
  state: string;
}

export interface TokenExchangeResult {
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
  token_type: string;
  scope: string | null;
  id_token: string | null;
}
