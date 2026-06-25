import { describe, it, expect } from 'vitest';
import {
  imapFolderAdapter,
  easFolderAdapter,
  graphFolderAdapter,
  gmailFolderAdapter,
  pickAdapter,
  sourceFromProvider,
} from '../../../src/services/mail/folders';
import type { ImapFolder } from '../../../src/types';
import type { EasFolder } from '../../../src/services/mail/easProvider';

const imap = (over: Partial<ImapFolder> = {}): ImapFolder => ({
  path: 'INBOX',
  raw_path: 'INBOX',
  name: 'INBOX',
  delimiter: '/',
  special_use: null,
  exists: 0,
  unseen: 0,
  ...over,
});

describe('imapFolderAdapter', () => {
  it('normalizes a user folder, deriving parent from delimiter', () => {
    const f = imapFolderAdapter.normalize(
      imap({
        path: 'Work/Project',
        raw_path: 'Work/Project',
        name: 'Project',
        exists: 5,
        unseen: 2,
      }),
      'acc-1',
    );
    expect(f.source).toBe('imap');
    expect(f.role).toBeNull();
    expect(f.name).toBe('Project');
    expect(f.remoteId).toBe('Work/Project');
    expect(f.parentId).toBe('Work');
    expect(f.unreadCount).toBe(2);
    expect(f.totalCount).toBe(5);
    expect(f.id).toBe('acc-1:Work/Project');
    expect(f.mailClass).toBe('mail');
  });

  it('detects role from special-use and leaves top-level parent null', () => {
    const f = imapFolderAdapter.normalize(imap({ special_use: '\\Inbox', unseen: 3 }), 'a');
    expect(f.role).toBe('inbox');
    expect(f.parentId).toBeNull();
  });
});

describe('easFolderAdapter', () => {
  const eas = (over: Partial<EasFolder> = {}): EasFolder => ({
    server_id: '1:5',
    parent_id: '0',
    display_name: 'Inbox',
    class: 'Email',
    ...over,
  });

  it('derives role from the surfaced Type byte', () => {
    const f = easFolderAdapter.normalize(eas({ folder_type: 2 }), 'acc-eas');
    expect(f.source).toBe('eas');
    expect(f.role).toBe('inbox');
    expect(f.remoteId).toBe('1:5');
    expect(f.parentId).toBe('0');
    expect(f.mailClass).toBe('mail');
    expect(f.unreadCount).toBe(0); // EAS FolderSync returns no counts
  });

  it('classifies non-mail folders and leaves role null', () => {
    const f = easFolderAdapter.normalize(
      eas({ server_id: '1:8', display_name: 'Calendar', class: 'Calendar', folder_type: 8 }),
      'a',
    );
    expect(f.mailClass).toBe('calendar');
    expect(f.role).toBeNull();
  });

  it('falls back to name for Junk (no dedicated Type role)', () => {
    const f = easFolderAdapter.normalize(
      eas({ server_id: '1:12', display_name: 'Junk E-mail', folder_type: 12 }),
      'a',
    );
    expect(f.role).toBe('junk');
  });
});

describe('graphFolderAdapter', () => {
  it('maps wellKnownName, parentFolderId, and native counts', () => {
    const f = graphFolderAdapter.normalize(
      {
        id: 'AAMkAG1=',
        displayName: 'Inbox',
        parentFolderId: 'root',
        wellKnownName: 'inbox',
        unreadItemCount: 4,
        totalItemCount: 9,
      },
      'acc-graph',
    );
    expect(f.source).toBe('graph');
    expect(f.role).toBe('inbox');
    expect(f.remoteId).toBe('AAMkAG1=');
    expect(f.parentId).toBe('root');
    expect(f.unreadCount).toBe(4);
    expect(f.totalCount).toBe(9);
  });
});

describe('gmailFolderAdapter', () => {
  it('maps system label id to role and carries counts', () => {
    const f = gmailFolderAdapter.normalize(
      { id: 'INBOX', name: 'Inbox', type: 'system', messagesTotal: 100, messagesUnread: 5 },
      'acc-g',
    );
    expect(f.source).toBe('gmail');
    expect(f.role).toBe('inbox');
    expect(f.unreadCount).toBe(5);
    expect(f.totalCount).toBe(100);
  });

  it('hides labels with labelListVisibility=labelHide', () => {
    const f = gmailFolderAdapter.normalize(
      { id: 'Label_1', name: 'Todo', labelListVisibility: 'labelHide' },
      'a',
    );
    expect(f.visible).toBe(false);
    expect(f.role).toBeNull();
  });
});

describe('pickAdapter / sourceFromProvider', () => {
  it('maps each provider to its adapter and source', () => {
    expect(pickAdapter('imap')).toBe(imapFolderAdapter);
    expect(pickAdapter('eas')).toBe(easFolderAdapter);
    expect(pickAdapter('gmail_api')).toBe(gmailFolderAdapter);
    expect(sourceFromProvider('imap')).toBe('imap');
    expect(sourceFromProvider('eas')).toBe('eas');
    expect(sourceFromProvider('gmail_api')).toBe('gmail');
  });
});
