// Tests for the rewritten EasProvider — verifies config mapping and Tauri invoke contract.
// Network commands are mocked — real integration tests live in Phase 10.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EasProvider, easConfigFromAccount } from '../../../src/services/mail/easProvider';
import type { Account } from '../../../src/types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-eas',
    email: 'administrator@kylins.com',
    provider: 'eas',
    isActive: true,
    createdAt: 1,
    updatedAt: 1,
    easUrl: 'https://mail.kylins.com/Microsoft-Server-ActiveSync',
    easProtocolVersion: '16.1',
    easDeviceId: 'KYLINS-DEV-001',
    easPolicyKey: '0',
    imapUsername: 'kylins\\administrator',
    imapPassword: 'P@ssw0rd',
    acceptInvalidCerts: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe('easConfigFromAccount', () => {
  it('maps account fields to Rust config', () => {
    const cfg = easConfigFromAccount(makeAccount());
    expect(cfg.url).toBe('https://mail.kylins.com/Microsoft-Server-ActiveSync');
    expect(cfg.username).toBe('kylins\\administrator');
    expect(cfg.password).toBe('P@ssw0rd');
    expect(cfg.protocol_version).toBe('16.1');
    expect(cfg.device_id).toBe('KYLINS-DEV-001');
    expect(cfg.device_type).toBe('KylinsMail');
    expect(cfg.user_agent).toBe('KylinsMail/1.0');
    expect(cfg.policy_key).toBe('0');
    expect(cfg.accept_invalid_certs).toBe(false);
  });

  it('falls back to email when imapUsername is absent', () => {
    const cfg = easConfigFromAccount(
      makeAccount({ imapUsername: undefined, imapPassword: 'pw' }),
    );
    expect(cfg.username).toBe('administrator@kylins.com');
  });

  it('throws when eas_url is missing', () => {
    expect(() => easConfigFromAccount(makeAccount({ easUrl: undefined }))).toThrow(
      /no eas_url/,
    );
  });

  it('throws when eas_device_id is missing', () => {
    expect(() => easConfigFromAccount(makeAccount({ easDeviceId: undefined }))).toThrow(
      /no eas_device_id/,
    );
  });

  it('defaults accept_invalid_certs to false', () => {
    const cfg = easConfigFromAccount(makeAccount({ acceptInvalidCerts: undefined }));
    expect(cfg.accept_invalid_certs).toBe(false);
  });

  it('defaults protocol_version to 16.1', () => {
    const cfg = easConfigFromAccount(makeAccount({ easProtocolVersion: undefined }));
    expect(cfg.protocol_version).toBe('16.1');
  });
});

describe('EasProvider', () => {
  it('has provider id "eas"', () => {
    const provider = new EasProvider(makeAccount());
    expect(provider.id).toBe('eas');
  });

  it('connect issues FolderSync with syncKey=0', async () => {
    vi.mocked(invoke).mockResolvedValue({
      sync_key: 'initial-key-1',
      changes: [],
      deletions: [],
    });
    const provider = new EasProvider(makeAccount());
    await provider.connect();
    expect(invoke).toHaveBeenCalledWith('eas_folder_sync', {
      config: expect.objectContaining({ url: expect.stringContaining('Microsoft-Server-ActiveSync') }),
      syncKey: '0',
    });
  });

  it('connect throws on empty returned sync key', async () => {
    vi.mocked(invoke).mockResolvedValue({
      sync_key: '0',
      changes: [],
      deletions: [],
    });
    const provider = new EasProvider(makeAccount());
    await expect(provider.connect()).rejects.toThrow(/invalid sync key/);
  });

  it('folderSync passes syncKey through', async () => {
    vi.mocked(invoke).mockResolvedValue({
      sync_key: 'next-key',
      changes: [],
      deletions: [],
    });
    const provider = new EasProvider(makeAccount());
    await provider.folderSync('current-key');
    expect(invoke).toHaveBeenCalledWith('eas_folder_sync', {
      config: expect.any(Object),
      syncKey: 'current-key',
    });
  });

  it('sendMail wraps request with base64 mime', async () => {
    vi.mocked(invoke).mockResolvedValue(1);
    const provider = new EasProvider(makeAccount());
    const status = await provider.sendMail({
      mime_base64: 'U0VORCBNRSE=',
      save_to_sent: true,
    });
    expect(status).toBe(1);
    expect(invoke).toHaveBeenCalledWith('eas_send_mail', {
      config: expect.any(Object),
      request: { mime_base64: 'U0VORCBNRSE=', save_to_sent: true },
    });
  });

  it('itemOperations forwards file_reference', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 1,
      data: 'QkFTRTY0',
      content_type: 'image/png',
    });
    const provider = new EasProvider(makeAccount());
    const result = await provider.itemOperations({
      server_id: 'srv-1',
      collection_id: 'col-1',
      file_reference: 'fileref-1',
    });
    expect(result.status).toBe(1);
    expect(result.data).toBe('QkFTRTY0');
    expect(result.content_type).toBe('image/png');
  });

  it('ping returns status string', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 'OK' });
    const provider = new EasProvider(makeAccount());
    const result = await provider.ping({
      heartbeat_interval: 60,
      monitored_collections: [{ collection_id: 'col-1', class: 'Email' }],
    });
    expect(result.status).toBe('OK');
  });

  it('folderCreate returns status + new server id tuple', async () => {
    vi.mocked(invoke).mockResolvedValue([1, 'new-fid']);
    const provider = new EasProvider(makeAccount());
    const result = await provider.folderCreate({
      parent_id: '0',
      display_name: 'Test',
      class: 'Email',
    });
    expect(result).toEqual([1, 'new-fid']);
  });

  it('syncFolder returns counts from sync result', async () => {
    vi.mocked(invoke).mockResolvedValue({
      sync_key: 'k',
      added: [{ server_id: 'a' }, { server_id: 'b' }],
      updated: [{ server_id: 'c' }],
      deleted_server_ids: ['d'],
      more_available: false,
    });
    const provider = new EasProvider(makeAccount());
    const result = await provider.syncFolder('col-1');
    expect(result.added).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.deleted).toBe(1);
  });

  it('smartForward passes source ids + replace_mime', async () => {
    vi.mocked(invoke).mockResolvedValue(1);
    const provider = new EasProvider(makeAccount());
    await provider.smartForward({
      mime_base64: 'bWltZQ==',
      save_to_sent: true,
      source_server_id: 'srv-1',
      source_collection_id: 'col-1',
      replace_mime: false,
    });
    expect(invoke).toHaveBeenCalledWith('eas_smart_forward', {
      config: expect.any(Object),
      request: {
        mime_base64: 'bWltZQ==',
        save_to_sent: true,
        source_server_id: 'srv-1',
        source_collection_id: 'col-1',
        replace_mime: false,
      },
    });
  });

  it('folderDelete passes server_id only', async () => {
    vi.mocked(invoke).mockResolvedValue([1, null]);
    const provider = new EasProvider(makeAccount());
    await provider.folderDelete({ server_id: 'fid-old' });
    expect(invoke).toHaveBeenCalledWith('eas_folder_delete', {
      config: expect.any(Object),
      request: { server_id: 'fid-old' },
    });
  });
});
