export interface Account {
  id: string;
  email: string;
  displayName?: string;
  provider: 'eas' | 'gmail_api' | 'imap';
  providerConfig?: Record<string, unknown>;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DbAccountRow {
  id: string;
  email: string;
  display_name?: string | null;
  provider: string;
  provider_config?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: number | null;
  is_active: number;
  created_at: number;
  updated_at: number;
}
