import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above all imports, so the mock fn must be created via
// vi.hoisted to be available inside the factory.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
const { openerMock } = vi.hoisted(() => ({ openerMock: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => openerMock(url) }));

import {
  buildOAuthImapAccount,
  buildImapAccount,
  buildEasAccount,
  runOAuthFlow,
  testImapConnection,
} from '../../../src/services/auth/accountSetupFlows';
import { getProvider } from '../../../src/services/auth/providers';

describe('accountSetupFlows', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openerMock.mockReset();
    openerMock.mockResolvedValue(undefined);
  });

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

  it('buildImapAccount maps a password provider with presets and defaults username to email', () => {
    const acc = buildImapAccount(getProvider('yahoo'), 'y@yahoo.com', 'apppass', 'Y User');
    expect(acc.provider).toBe('imap');
    expect(acc.authMethod).toBe('password');
    expect(acc.displayName).toBe('Y User');
    expect(acc.imapPassword).toBe('apppass');
    expect(acc.imapUsername).toBe('y@yahoo.com');
    expect(acc.smtpUsername).toBe('y@yahoo.com');
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

  it('testImapConnection throws when smtp_test_connection reports failure', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'imap_test_connection')
        return Promise.resolve('Connected successfully. Found 3 folder(s).');
      if (cmd === 'smtp_test_connection')
        return Promise.resolve({ success: false, message: 'SMTP handshake failed' });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const account = {
      ...buildImapAccount(getProvider('yahoo'), 'y@yahoo.com', 'apppass'),
      id: 'acct-1',
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    };
    await expect(testImapConnection(account)).rejects.toThrow('SMTP handshake failed');
  });

  it('testImapConnection resolves when both imap and smtp succeed', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'imap_test_connection')
        return Promise.resolve('Connected successfully. Found 3 folder(s).');
      if (cmd === 'smtp_test_connection')
        return Promise.resolve({ success: true, message: 'Connection successful' });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const account = {
      ...buildImapAccount(getProvider('yahoo'), 'y@yahoo.com', 'apppass'),
      id: 'acct-1',
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    };
    await expect(testImapConnection(account)).resolves.toBeUndefined();
  });

  it('runOAuthFlow opens the browser BEFORE binding the loopback listener', async () => {
    // If the opener throws, no listener should be started (no leaked port).
    mockOAuthCommands();
    openerMock.mockRejectedValueOnce(new Error('opener failed'));
    await expect(
      runOAuthFlow(getProvider('gmail'), { email: 'g@x.com', clientId: 'CID' }),
    ).rejects.toThrow('opener failed');
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).not.toContain('start_oauth_server');
  });

  it('runOAuthFlow surfaces the real auth URL via onStarted', async () => {
    mockOAuthCommands();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ email: 'g@x.com' }), { status: 200 }));
    let startedUrl = '';
    await runOAuthFlow(getProvider('gmail'), {
      email: 'g@x.com',
      clientId: 'CID',
      onStarted: (url) => {
        startedUrl = url;
      },
    });
    expect(startedUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(startedUrl).toContain('client_id=CID');
    expect(startedUrl).toContain('login_hint=g%40x.com');
    fetchSpy.mockRestore();
  });
});
