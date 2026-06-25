// Folder source abstraction — public surface. The rest of the app imports from
// here and never touches the raw provider wire formats directly.

export type { FolderSource, FolderRole, MailFolderClass, MailFolder } from './folderModel';
export { SYSTEM_ROLE_ORDER, roleOrderIndex } from './folderModel';

export {
  roleFromSpecialUse,
  roleFromEasType,
  easClassOf,
  roleFromGraphWellKnown,
  roleFromNameFallback,
  roleFromGmailId,
} from './folderRoles';

export {
  type FolderSourceAdapter,
  type GraphMailFolderResource,
  type GmailLabelResource,
  imapFolderAdapter,
  easFolderAdapter,
  graphFolderAdapter,
  gmailFolderAdapter,
  pickAdapter,
  sourceFromProvider,
} from './adapters';
