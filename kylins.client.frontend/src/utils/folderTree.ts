import type { MailFolder } from '../services/mail/folders';

export interface FolderTreeNode {
  folder: MailFolder;
  children: FolderTreeNode[];
}

/**
 * Build a forest from a flat folder list by matching each folder's parentId to a
 * sibling's remoteId (EAS parent_id / Graph parentFolderId / IMAP parent path).
 * Folders whose parent isn't in the set are treated as roots, so partial syncs
 * and flat providers (Gmail) render correctly.
 */
export function buildFolderTree(folders: MailFolder[]): FolderTreeNode[] {
  const nodes: FolderTreeNode[] = folders.map((folder) => ({ folder, children: [] }));

  const byRemoteId = new Map<string, FolderTreeNode>();
  for (const node of nodes) {
    if (node.folder.remoteId) byRemoteId.set(node.folder.remoteId, node);
  }

  const roots: FolderTreeNode[] = [];
  for (const node of nodes) {
    const parent = node.folder.parentId ? byRemoteId.get(node.folder.parentId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
