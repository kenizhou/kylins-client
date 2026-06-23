import type { TokenExchangeResult } from '../../types';
import type { OAuthProviderConfig } from './providers';

export interface ProviderUserInfo {
  email: string;
  displayName?: string;
  avatarUrl?: string;
}

function base64UrlDecode(segment: string): string {
  const pad = segment.length % 4 === 0 ? '' : '='.repeat(4 - (segment.length % 4));
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const parts = idToken.split('.');
  if (parts.length < 2) throw new Error('Malformed id_token');
  return JSON.parse(base64UrlDecode(parts[1]!));
}

export async function fetchUserInfo(
  config: OAuthProviderConfig,
  tokens: TokenExchangeResult,
  fallbackEmail: string,
): Promise<ProviderUserInfo> {
  if (config.oauthProvider === 'microsoft') {
    if (!tokens.id_token) return { email: fallbackEmail };
    // decodeIdTokenClaims throws on a malformed id_token; degrade gracefully
    // to the fallback email so the caller never has to defend against throws
    // (matches the Google branch's contract).
    let claims: Record<string, unknown>;
    try {
      claims = decodeIdTokenClaims(tokens.id_token);
    } catch {
      return { email: fallbackEmail };
    }
    const email =
      (claims.email as string) || (claims.preferred_username as string) || fallbackEmail;
    return {
      email,
      displayName: claims.name as string | undefined,
    };
  }

  // Google: call userinfo endpoint.
  if (!config.userInfoUrl) return { email: fallbackEmail };
  const res = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!res.ok) return { email: fallbackEmail };
  const body = (await res.json()) as { email?: string; name?: string; picture?: string };
  return {
    email: body.email ?? fallbackEmail,
    displayName: body.name,
    avatarUrl: body.picture,
  };
}
