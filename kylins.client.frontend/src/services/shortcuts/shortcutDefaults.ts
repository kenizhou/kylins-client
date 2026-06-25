export type ShortcutSet = 'mac' | 'win';

export interface ShortcutCommand {
  id: string;
  label: string;
  category: string;
  defaultBindings: Record<ShortcutSet, string>;
}

export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  /* ---------- Application ---------- */
  {
    id: 'app:new-mail',
    label: 'New Mail',
    category: 'Application',
    defaultBindings: { mac: 'mod+n', win: 'ctrl+n' },
  },
  {
    id: 'app:close-window',
    label: 'Close Window',
    category: 'Application',
    defaultBindings: { mac: 'mod+w', win: 'ctrl+w' },
  },
  {
    id: 'app:reload',
    label: 'Reload',
    category: 'Application',
    defaultBindings: { mac: 'mod+shift+r', win: 'ctrl+shift+r' },
  },
  {
    id: 'app:show-shortcuts-help',
    label: 'Show Shortcuts',
    category: 'Application',
    defaultBindings: { mac: 'mod+/', win: 'ctrl+/' },
  },

  /* ---------- Edit ---------- */
  {
    id: 'edit:undo',
    label: 'Undo',
    category: 'Edit',
    defaultBindings: { mac: 'mod+z', win: 'ctrl+z' },
  },
  {
    id: 'edit:redo',
    label: 'Redo',
    category: 'Edit',
    defaultBindings: { mac: 'mod+shift+z', win: 'ctrl+shift+z' },
  },
  {
    id: 'edit:cut',
    label: 'Cut',
    category: 'Edit',
    defaultBindings: { mac: 'mod+x', win: 'ctrl+x' },
  },
  {
    id: 'edit:copy',
    label: 'Copy',
    category: 'Edit',
    defaultBindings: { mac: 'mod+c', win: 'ctrl+c' },
  },
  {
    id: 'edit:paste',
    label: 'Paste',
    category: 'Edit',
    defaultBindings: { mac: 'mod+v', win: 'ctrl+v' },
  },
  {
    id: 'edit:paste-and-match-style',
    label: 'Paste and Match Style',
    category: 'Edit',
    defaultBindings: { mac: 'mod+alt+shift+v', win: 'ctrl+alt+shift+v' },
  },
  {
    id: 'edit:select-all',
    label: 'Select All',
    category: 'Edit',
    defaultBindings: { mac: 'mod+a', win: 'ctrl+a' },
  },
  {
    id: 'edit:find',
    label: 'Find in Thread',
    category: 'Edit',
    defaultBindings: { mac: 'mod+f', win: 'ctrl+f' },
  },

  /* ---------- View ---------- */
  {
    id: 'view:toggle-folder-pane',
    label: 'Show/Hide Folder Pane',
    category: 'View',
    defaultBindings: { mac: 'mod+shift+f', win: 'ctrl+shift+f' },
  },
  {
    id: 'view:toggle-command-ribbon',
    label: 'Show/Hide Command Ribbon',
    category: 'View',
    defaultBindings: { mac: 'mod+shift+r', win: 'ctrl+shift+r' },
  },
  {
    id: 'view:toggle-status-bar',
    label: 'Show/Hide Status Bar',
    category: 'View',
    defaultBindings: { mac: 'mod+shift+s', win: 'ctrl+shift+s' },
  },
  {
    id: 'view:reading-pane',
    label: 'Cycle Reading Pane Position',
    category: 'View',
    defaultBindings: { mac: 'mod+alt+r', win: 'ctrl+alt+r' },
  },

  /* ---------- Mail ---------- */
  {
    id: 'mail:sync',
    label: 'Sync New Mail Now',
    category: 'Mail',
    defaultBindings: { mac: 'f5', win: 'f5' },
  },
  {
    id: 'mail:next-message',
    label: 'Next Message',
    category: 'Mail',
    defaultBindings: { mac: 'j', win: 'j' },
  },
  {
    id: 'mail:prev-message',
    label: 'Previous Message',
    category: 'Mail',
    defaultBindings: { mac: 'k', win: 'k' },
  },
  {
    id: 'mail:toggle-read',
    label: 'Mark as Read/Unread',
    category: 'Mail',
    defaultBindings: { mac: 'mod+shift+u', win: 'ctrl+shift+u' },
  },
  {
    id: 'mail:archive',
    label: 'Archive',
    category: 'Mail',
    defaultBindings: { mac: 'e', win: 'e' },
  },

  /* ---------- Go ---------- */
  {
    id: 'go:mail',
    label: 'Go to Mail',
    category: 'Go',
    defaultBindings: { mac: 'mod+1', win: 'ctrl+1' },
  },
  {
    id: 'go:calendar',
    label: 'Go to Calendar',
    category: 'Go',
    defaultBindings: { mac: 'mod+2', win: 'ctrl+2' },
  },
  {
    id: 'go:inbox',
    label: 'Go to Inbox',
    category: 'Go',
    defaultBindings: { mac: 'g i', win: 'g i' },
  },
  {
    id: 'go:sent',
    label: 'Go to Sent',
    category: 'Go',
    defaultBindings: { mac: 'g s', win: 'g s' },
  },
  {
    id: 'go:drafts',
    label: 'Go to Drafts',
    category: 'Go',
    defaultBindings: { mac: 'g d', win: 'g d' },
  },
];

export function getDefaultKeyMap(set: ShortcutSet): Record<string, string> {
  const map: Record<string, string> = {};
  for (const cmd of SHORTCUT_COMMANDS) {
    map[cmd.id] = cmd.defaultBindings[set];
  }
  return map;
}

export function getCommandById(id: string): ShortcutCommand | undefined {
  return SHORTCUT_COMMANDS.find((cmd) => cmd.id === id);
}

const COMMANDS_BY_CATEGORY: Record<string, ShortcutCommand[]> = {};
const CATEGORIES: string[] = [];
{
  const seen = new Set<string>();
  for (const cmd of SHORTCUT_COMMANDS) {
    if (!seen.has(cmd.category)) {
      seen.add(cmd.category);
      CATEGORIES.push(cmd.category);
    }
    (COMMANDS_BY_CATEGORY[cmd.category] ??= []).push(cmd);
  }
}

export function getCategories(): string[] {
  return CATEGORIES;
}

export function getCommandsByCategory(category: string): ShortcutCommand[] {
  return COMMANDS_BY_CATEGORY[category] ?? [];
}
