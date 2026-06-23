import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted above all imports, so the mock fn must be created via
// vi.hoisted to be available inside the factory.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

import {
  buildOAuthImapAccount,
  buildImapAccount,
  buildEasAccount,
  runOAuthFlow,
  testImapConnection,
} from '../../../src/services/auth/accountSetupFlows';
import { getProvider } from '../../../src/services/auth/providers';

describe('accountSetupFlows', () => {
  // Stubs the two invoke commands every OAuth flow hits. `idToken` is the
  // only thing that varies between tests, so it's the lone knob.
  function mockOAuthCommands(idToken: string | null = null) {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'start_oauth_server') return Promise.resolve({ code: 'CODE', state: 'STATE' });
      if (cmd === 'oauth_exchange_token')
        return Promise.resolve({
          access_token: 'tok',
          refresh_token: 'ref',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: null,
          id_token: idToken,
        });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
  }

  it('buildOAuthImapAccount maps tokens+userinfo into an imap+xoauth2 account', () => {
    const cfg = getProvider('gmail');
    const acc = buildOAuthImapAccount(
      cfg,
      { email: 'g@x.com', displayName: 'G' },
      {
        access_token: 'tok',
        refresh_token: 'ref',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: null,
        id_token: null,
      },
      'CID',
    );
    expect(acc.provider).toBe('imap');
    expect(acc.authMethod).toBe('oauth2');
    expect(acc.oauthProvider).toBe('google');
    expect(acc.oauthClientId).toBe('CID');
    expect(acc.accessToken).toBe('tok');
    expect(acc.refreshToken).toBe('ref');
    expect(acc.imapHost).toBe('imap.gmail.com');
    expect(acc.smtpPort).toBe(587);
    expect(acc.email).toBe('g@x.com');
  });

  it('buildImapAccount maps a password provider with presets', () => {
    const acc = buildImapAccount(getProvider('yahoo'), 'y@yahoo.com', 'apppass');
    expect(acc.provider).toBe('imap');
    expect(acc.authMethod).toBe('password');
    expect(acc.imapPassword).toBe('apppass');
    expect(acc.imapHost).toBe('imap.mail.yahoo.com');
  });

  it('buildEasAccount maps an eas account', () => {
    const acc = buildEasAccount(
      'e@ex.com',
      'pw',
      'https://ex.com/Microsoft-Server-ActiveSync',
      'DEV-1',
    );
    expect(acc.provider).toBe('eas');
    expect(acc.easUrl).toBe('https://ex.com/Microsoft-Server-ActiveSync');
    expect(acc.easDeviceId).toBe('DEV-1');
    expect(acc.easProtocolVersion).toBe('16.1');
  });

  it('runOAuthFlow starts server, opens browser, exchanges code', async () => {
    mockOAuthCommands();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ email: 'g@x.com' }), { status: 200 }));
    const { tokens, userInfo } = await runOAuthFlow(getProvider('gmail'), {
      email: 'g@x.com',
      clientId: 'CID',
    });
    expect(tokens.access_token).toBe('tok');
    expect(userInfo.email).toBe('g@x.com');
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('start_oauth_server');
    expect(cmds).toContain('oauth_exchange_token');
    fetchSpy.mockRestore();
  });

  it('runOAuthFlow falls back to typed email when the id_token is malformed', async () => {
    // Microsoft path with a malformed id_token: fetchUserInfo degrades to the
    // typed email instead of throwing — flow still resolves.
    mockOAuthCommands('not.a.valid.jwt');
    const { userInfo } = await runOAuthFlow(getProvider('outlook'), {
      email: 'typed@x.com',
      clientId: 'CID',
    });
    expect(userInfo.email).toBe('typed@x.com');
  });

  it('testImapConnection throws when imap_test_connection fails', async () => {
    invokeMock.mockResolvedValue('Connection failed: auth error');
    // buildImapAccount returns CreateAccountInput; testImapConnection reads
    // only the imap_* fields, so we pad the rest to satisfy the Account type.
    const account = {
      ...buildImapAccount(getProvider('yahoo'), 'y@yahoo.com', 'apppass'),
      id: 'acct-1',
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    };
    await expect(testImapConnection(account)).rejects.toThrow();
  });
});
