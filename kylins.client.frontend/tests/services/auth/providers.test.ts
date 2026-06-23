import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  getProvider,
  buildAuthUrl,
  presetsFor,
  OAUTH_CALLBACK_PORT,
} from '../../../src/services/auth/providers';

describe('providers', () => {
  it('exposes the six setup providers', () => {
    const ids = Object.keys(PROVIDERS).sort();
    expect(ids).toEqual(['exchange', 'gmail', 'imap', 'microsoft365', 'outlook', 'yahoo']);
  });

  it('marks gmail/outlook/microsoft365 as oauth2', () => {
    expect(getProvider('gmail').authType).toBe('oauth2');
    expect(getProvider('outlook').authType).toBe('oauth2');
    expect(getProvider('microsoft365').authType).toBe('oauth2');
  });

  it('marks yahoo/imap/exchange as password', () => {
    expect(getProvider('yahoo').authType).toBe('password');
    expect(getProvider('imap').authType).toBe('password');
    expect(getProvider('exchange').authType).toBe('password');
  });

  it('builds a google auth url with pkce + offline access', () => {
    const cfg = getProvider('gmail');
    const url = buildAuthUrl(cfg, {
      clientId: 'CID',
      redirectUri: `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`,
      codeChallenge: 'CHALLENGE',
      state: 'STATE',
      email: 'user@gmail.com',
    });
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(url).toContain('client_id=CID');
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge=CHALLENGE');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=STATE');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('login_hint=user%40gmail.com');
  });

  it('returns presets for providers that have them', () => {
    expect(presetsFor(getProvider('gmail'))?.imapHost).toBe('imap.gmail.com');
    expect(presetsFor(getProvider('imap'))).toBeUndefined();
  });
});
