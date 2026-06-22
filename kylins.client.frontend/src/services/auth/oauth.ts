// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

import { invoke } from '@tauri-apps/api/core';
import type { OAuthResult, TokenExchangeResult } from '../../types';

export async function startOAuthServer(port: number, state: string): Promise<OAuthResult> {
  return invoke<OAuthResult>('start_oauth_server', { port, state });
}

export async function exchangeToken(params: {
  tokenUrl: string;
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier?: string;
  clientSecret?: string;
  scope?: string;
}): Promise<TokenExchangeResult> {
  return invoke<TokenExchangeResult>('oauth_exchange_token', {
    tokenUrl: params.tokenUrl,
    code: params.code,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeVerifier: params.codeVerifier ?? null,
    clientSecret: params.clientSecret ?? null,
    scope: params.scope ?? null,
  });
}

export async function refreshToken(params: {
  tokenUrl: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
}): Promise<TokenExchangeResult> {
  return invoke<TokenExchangeResult>('oauth_refresh_token', {
    tokenUrl: params.tokenUrl,
    refreshToken: params.refreshToken,
    clientId: params.clientId,
    clientSecret: params.clientSecret ?? null,
    scope: params.scope ?? null,
  });
}

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

export function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]!);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
