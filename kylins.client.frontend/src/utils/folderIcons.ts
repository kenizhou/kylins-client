import type { ComponentType } from 'react';
import {
  ArchiveIcon,
  BellIcon,
  FileTextIcon,
  FlagIcon,
  FolderIcon,
  MailIcon,
  SendIcon,
  TrashIcon,
  type IconProps,
} from '../components/icons';
import type { FolderRole } from '../services/mail/folders';

const ROLE_ICON: Partial<Record<FolderRole, ComponentType<IconProps>>> = {
  inbox: MailIcon,
  sent: SendIcon,
  drafts: FileTextIcon,
  junk: BellIcon,
  trash: TrashIcon,
  archive: ArchiveIcon,
  outbox: SendIcon,
  flagged: FlagIcon,
  starred: FlagIcon,
  important: FlagIcon,
  all: MailIcon,
};

/** Pick an icon for a folder by canonical role, falling back to a generic folder. */
export function getFolderIcon(role: FolderRole | null): ComponentType<IconProps> {
  return (role && ROLE_ICON[role]) || FolderIcon;
}
