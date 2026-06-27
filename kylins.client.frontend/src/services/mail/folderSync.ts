import { ImapProvider } from './imapProvider';
import { EasProvider } from './easProvider';
import { upsertFolders } from '../db/labels';
import { upsertImapMessages } from '../db/threads';
import { imapFolderAdapter, easFolderAdapter } from './folders/adapters';
import type { Account } from '../../types';
import type { MailFolder } from './folders/folderModel';

/**
 * Fetch the folder hierarchy from the server for an account and persist it
 * into the unified `labels` table. This is the initial folder-list sync that
 * makes the FolderPane populate after account creation.
 */
export async function syncAccountFolders(account: Account): Promise<MailFolder[]> {
  let folders: MailFolder[] = [];

  if (account.provider === 'imap') {
    const provider = new ImapProvider(account);
    const rawFolders = await provider.listFolders();
    folders = rawFolders.map((raw) => imapFolderAdapter.normalize(raw, account.id));
  } else if (account.provider === 'eas') {
    const provider = new EasProvider(account);
    const result = await provider.folderSync('0');
    folders = result.changes.map((raw) => easFolderAdapter.normalize(raw, account.id));
  } else {
    // gmail_api / other providers don't have a folder-list sync path yet.
    return folders;
  }

  await upsertFolders(folders);
  return folders;
}

/**
 * Fetch messages for one folder and persist them into threads/messages.
 * Returns the number of messages written.
 */
export async function syncFolderMessages(
  account: Account,
  folder: MailFolder,
  batchSize = 50,
): Promise<number> {
  if (account.provider !== 'imap') return 0;
  const provider = new ImapProvider(account);
  const result = await provider.syncFolderBatched(folder.remoteId, batchSize);
  await upsertImapMessages(account.id, folder.id, result.messages);
  return result.messages.length;
}
