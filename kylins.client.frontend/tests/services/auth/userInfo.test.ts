import { describe, it, expect, vi } from 'vitest';
import { decodeIdTokenClaims, fetchUserInfo } from '../../../src/services/auth/userInfo';
import { getProvider } from '../../../src/services/auth/providers';
import type { TokenExchangeResult } from '../../../src/types';

describe('userInfo', () => {
  it('decodes a jwt payload (base64url, no signature verification)', () => {
    // header.{"email":"a@b.com","name":"A B"}.sig  — payload is base64url of the JSON
    const payload = btoa(JSON.stringify({ email: 'a@b.com', name: 'A B' })).replace(/=/g, '');
    const jwt = `header.${payload}.signature`;
    const claims = decodeIdTokenClaims(jwt);
    expect(claims.email).toBe('a@b.com');
    expect(claims.name).toBe('A B');
  });

  it('fetches google userinfo from the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ email: 'g@x.com', name: 'G', picture: 'u' }), {
        status: 200,
      }),
    );
    const cfg = getProvider('gmail');
    const tokens: TokenExchangeResult = {
      access_token: 'tok',
      refresh_token: null,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: null,
      id_token: null,
    };
    const info = await fetchUserInfo(cfg, tokens, 'fallback@x.com');
    expect(info.email).toBe('g@x.com');
    expect(info.displayName).toBe('G');
    expect(info.avatarUrl).toBe('u');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    );
    fetchSpy.mockRestore();
  });

  it('parses microsoft id_token instead of calling graph', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cfg = getProvider('outlook');
    const payload = btoa(
      JSON.stringify({ email: 'm@x.com', preferred_username: 'm@x.com', name: 'M' }),
    ).replace(/=/g, '');
    const tokens: TokenExchangeResult = {
      access_token: 'tok',
      refresh_token: null,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: null,
      id_token: `h.${payload}.s`,
    };
    const info = await fetchUserInfo(cfg, tokens, 'fallback@x.com');
    expect(info.email).toBe('m@x.com');
    expect(info.displayName).toBe('M');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('falls back to the typed email when a microsoft id_token is malformed', async () => {
    const cfg = getProvider('outlook');
    const tokens: TokenExchangeResult = {
      access_token: 'tok',
      refresh_token: null,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: null,
      id_token: 'not.a.valid.jwt',
    };
    const info = await fetchUserInfo(cfg, tokens, 'fallback@x.com');
    expect(info.email).toBe('fallback@x.com');
  });
});
