// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

import { invoke } from '@tauri-apps/api/core';
import type { Account, SmtpSendResult } from '../../types';

interface RustSmtpConfig {
  host: string;
  port: number;
  security: string;
  username: string;
  password: string;
  auth_method: string;
  accept_invalid_certs: boolean;
}

export function smtpConfigFromAccount(account: Account): RustSmtpConfig {
  return {
    host: account.smtpHost ?? '',
    port: account.smtpPort ?? 587,
    security: account.smtpSecurity ?? 'starttls',
    username: account.imapUsername ?? account.email,
    password: account.imapPassword ?? '',
    auth_method: account.authMethod ?? 'password',
    accept_invalid_certs: account.acceptInvalidCerts ?? false,
  };
}

export async function sendEmail(
  account: Account,
  rawEmailBase64url: string,
): Promise<SmtpSendResult> {
  return invoke<SmtpSendResult>('smtp_send_email', {
    config: smtpConfigFromAccount(account),
    rawEmail: rawEmailBase64url,
  });
}

export async function testConnection(account: Account): Promise<SmtpSendResult> {
  return invoke<SmtpSendResult>('smtp_test_connection', {
    config: smtpConfigFromAccount(account),
  });
}
