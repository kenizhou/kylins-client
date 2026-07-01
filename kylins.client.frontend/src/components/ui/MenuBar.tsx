import { useEffect, useRef, useState, useCallback } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useShortcutStore } from '../../stores/shortcutStore';
import { executeCommand } from '../../hooks/useKeyboardShortcuts';
import { formatBindingForDisplay } from '../../services/shortcuts/shortcutEngine';
import { isMac } from '../../utils/platform';
import { MenuItem } from './MenuItem';
import { ViewMenu } from '../../features/view/components/ViewMenu';
import { useComposerStore } from '../../stores/composerStore';

// ---------- Shared hover-timeout hook ----------

function useMenuHoverState<T>(delay = 100) {
  const [active, setActive] = useState<T | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleClose = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setActive(null);
    }, delay);
  }, [delay]);

  const cancelClose = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const open = useCallback(
    (value: T) => {
      cancelClose();
      setActive(value);
    },
    [cancelClose],
  );

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { active, scheduleClose, cancelClose, open, setActive };
}

type MenuActionItem = {
  label: string;
  commandId?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  onClick?: () => void;
};

type MenuSeparatorItem = {
  type: 'separator';
};

type MenuSubmenuItem = {
  label: string;
  type: 'submenu';
  items: MenuItemData[];
};

type MenuItemData = MenuActionItem | MenuSeparatorItem | MenuSubmenuItem;

interface MenuCategoryData {
  label: string;
  items: MenuItemData[] | React.ReactNode;
  customContent?: boolean;
}

const EDIT_ITEMS: MenuItemData[] = [
  { label: 'Undo', commandId: 'edit:undo' },
  { label: 'Redo', commandId: 'edit:redo' },
  { type: 'separator' },
  { label: 'Cut', commandId: 'edit:cut' },
  { label: 'Copy', commandId: 'edit:copy' },
  { label: 'Paste', commandId: 'edit:paste' },
  {
    label: 'Paste and Match Style',
    commandId: 'edit:paste-and-match-style',
    disabled: true,
  },
  { type: 'separator' },
  { label: 'Select All', commandId: 'edit:select-all' },
  { type: 'separator' },
  { label: 'Select All Read', disabled: true },
  { label: 'Select All Unread', disabled: true },
  { label: 'Select All Starred', disabled: true },
  { label: 'Select All Untarred', disabled: true },
  { type: 'separator' },
  { label: 'Mark All as Read', disabled: true },
  { type: 'separator' },
  {
    label: 'Find',
    type: 'submenu',
    items: [
      { label: 'Find in Mailbox…', disabled: true },
      { label: 'Find in Thread…', commandId: 'edit:find', disabled: true },
      { type: 'separator' },
      { label: 'Find Next', disabled: true },
      { label: 'Find Previous', disabled: true },
    ],
  },
];

const MAIN_CATEGORIES: MenuCategoryData[] = [
  {
    label: 'File',
    items: [
      { label: 'New Mail', commandId: 'app:new-mail' },
      {
        label: 'Add account…',
        commandId: 'app:add-account',
        onClick: () => {
          useUIStore.getState().setActiveMenuCategory(null);
          executeCommand('app:add-account');
        },
      },
      { label: 'New Window', disabled: true },
      { label: 'Close Window', commandId: 'app:close-window' },
      { type: 'separator' },
      { label: 'Sync New Mail Now', commandId: 'mail:sync', disabled: true },
      { type: 'separator' },
      {
        label: 'Preferences',
        commandId: 'app:preferences',
        onClick: () => {
          useUIStore.getState().setActiveMenuCategory(null);
          executeCommand('app:preferences');
        },
      },
      { label: 'Print', commandId: 'app:print' },
      { type: 'separator' },
      {
        label: 'Exit',
        commandId: 'app:close-window',
        onClick: () => {
          useUIStore.getState().setActiveMenuCategory(null);
          executeCommand('app:close-window');
        },
      },
    ],
  },
  {
    label: 'Edit',
    items: EDIT_ITEMS,
  },
  {
    label: 'View',
    items: [],
    customContent: true,
  },
  {
    label: 'Tools',
    items: [
      { label: 'Change Theme…', commandId: 'app:preferences-appearance' },
      { label: 'Run with Debug Flags', commandId: 'app:toggle-debug-flags' },
      { type: 'separator' },
      { label: 'Create a Plugin…', commandId: 'app:create-plugin' },
      { label: 'Install a Plugin…', commandId: 'app:install-plugin' },
      { type: 'separator' },
      {
        label: 'Reload',
        commandId: 'app:reload',
      },
      { label: 'Developer Tools', commandId: 'app:open-devtools' },
      { type: 'separator' },
      { label: 'Open Mailsync Logs', commandId: 'app:open-logs' },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: 'Documentation', commandId: 'app:show-shortcuts-help', disabled: true },
      { type: 'separator' },
      { label: 'Version', disabled: true },
      { label: 'Check for Updates', disabled: true },
      { type: 'separator' },
      { label: 'About', disabled: true },
    ],
  },
];

const VIEWER_CATEGORIES: MenuCategoryData[] = [
  {
    label: 'Message',
    items: [
      { label: 'Reply', commandId: 'mail:reply' },
      { label: 'Reply All', commandId: 'mail:reply-all' },
      { label: 'Forward', commandId: 'mail:forward' },
      { type: 'separator' },
      { label: 'Mark as Read', commandId: 'mail:toggle-read' },
      { label: 'Archive', commandId: 'mail:archive' },
      { type: 'separator' },
      { label: 'Close Window', commandId: 'app:close-window' },
    ],
  },
  {
    label: 'View',
    items: [],
    customContent: true,
  },
  {
    label: 'Help',
    items: [
      { label: 'Documentation', commandId: 'app:show-shortcuts-help', disabled: true },
      { type: 'separator' },
      { label: 'About', disabled: true },
    ],
  },
];

function runDocCommand(command: string): void {
  try {
    document.execCommand(command, false);
  } catch {
    /* ignore */
  }
}

function getComposeCategories(): MenuCategoryData[] {
  const store = useComposerStore.getState();
  return [
    {
      label: 'Message',
      items: [
        {
          label: 'Send',
          onClick: () => {
            useUIStore.getState().setActiveMenuCategory(null);
            // Composer window sends via its own Send button; this is a fallback.
            window.dispatchEvent(new Event('composer:send-requested'));
          },
        },
        { type: 'separator' },
        { label: 'Attach File…', disabled: true },
        { type: 'separator' },
        { label: 'Close Window', commandId: 'app:close-window' },
      ],
    },
    {
      label: 'Insert',
      items: [
        { label: 'Attachment…', disabled: true },
        { label: 'Link…', onClick: () => window.dispatchEvent(new Event('composer:insert-link')) },
        { type: 'separator' },
        { label: 'Signature', disabled: true },
      ],
    },
    {
      label: 'Options',
      items: [
        {
          label: 'High Importance',
          checked: store.importance === 'high',
          onClick: () => useComposerStore.getState().setImportance('high'),
        },
        {
          label: 'Low Importance',
          checked: store.importance === 'low',
          onClick: () => useComposerStore.getState().setImportance('low'),
        },
        { type: 'separator' },
        {
          label: 'Request Read Receipt',
          checked: store.requestReadReceipt,
          onClick: () => {
            const s = useComposerStore.getState();
            s.setRequestReadReceipt(!s.requestReadReceipt);
          },
        },
        {
          label: 'Delay Delivery…',
          onClick: () => window.dispatchEvent(new Event('composer:schedule-requested')),
        },
        { type: 'separator' },
        {
          label: 'Encrypt',
          checked: store.isEncrypted,
          disabled:
            store.classificationId === 'confidential' || store.classificationId === 'restricted',
          onClick: () => {
            const s = useComposerStore.getState();
            s.setIsEncrypted(!s.isEncrypted);
          },
        },
        {
          label: 'Sign',
          checked: store.isSigned,
          disabled:
            store.classificationId === 'confidential' || store.classificationId === 'restricted',
          onClick: () => {
            const s = useComposerStore.getState();
            s.setIsSigned(!s.isSigned);
          },
        },
        {
          label: 'Prevent Copy',
          checked: store.preventCopy,
          onClick: () => {
            const s = useComposerStore.getState();
            s.setPreventCopy(!s.preventCopy);
          },
        },
      ],
    },
    {
      label: 'Format',
      items: [
        { label: 'Bold', onClick: () => runDocCommand('bold') },
        { label: 'Italic', onClick: () => runDocCommand('italic') },
        { label: 'Underline', onClick: () => runDocCommand('underline') },
        { type: 'separator' },
        { label: 'Bulleted List', onClick: () => runDocCommand('insertUnorderedList') },
        { label: 'Numbered List', onClick: () => runDocCommand('insertOrderedList') },
      ],
    },
    {
      label: 'Review',
      items: [
        { label: 'Spelling', disabled: true },
        { type: 'separator' },
        { label: 'Check Accessibility', disabled: true },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Documentation', commandId: 'app:show-shortcuts-help', disabled: true },
        { type: 'separator' },
        { label: 'About', disabled: true },
      ],
    },
  ];
}

function isSeparator(item: MenuItemData): item is MenuSeparatorItem {
  return 'type' in item && item.type === 'separator';
}

function isSubmenu(item: MenuItemData): item is MenuSubmenuItem {
  return 'type' in item && item.type === 'submenu';
}

interface MenuDropdownProps {
  items: MenuItemData[];
  onClose: () => void;
  className?: string;
}

function MenuDropdown({ items, onClose, className = '' }: MenuDropdownProps) {
  const { active, scheduleClose, cancelClose, open } = useMenuHoverState<string>();
  const keyMap = useShortcutStore((s) => s.keyMap);
  const mac = isMac();

  return (
    <div
      className={`bg-[var(--surface)] border border-[var(--border)] shadow-lg rounded py-1 ${className}`}
      onMouseLeave={scheduleClose}
    >
      {items.map((item, index) => {
        if (isSeparator(item)) {
          return <div key={`sep-${index}`} className="my-1 border-t border-[var(--border)]" />;
        }

        if (isSubmenu(item)) {
          const isActive = active === item.label;
          return (
            <div key={item.label} className="relative" onMouseEnter={() => open(item.label)}>
              <MenuItem label={item.label} disabled={item.items.length === 0} hasSubmenu />
              {isActive && (
                <div
                  className="absolute top-0 left-full ml-0.5 w-56 z-50"
                  onMouseEnter={cancelClose}
                  onMouseLeave={scheduleClose}
                >
                  <MenuDropdown items={item.items} onClose={onClose} />
                </div>
              )}
            </div>
          );
        }

        return (
          <MenuItem
            key={item.label}
            label={item.label}
            shortcut={
              item.shortcut ??
              (item.commandId && keyMap[item.commandId]
                ? formatBindingForDisplay(keyMap[item.commandId]!, mac)
                : undefined)
            }
            disabled={item.disabled}
            checked={item.checked}
            onClick={() => {
              if (item.onClick) {
                item.onClick();
              } else if (item.commandId) {
                executeCommand(item.commandId);
              }
              onClose();
            }}
          />
        );
      })}
    </div>
  );
}

export interface MenuBarProps {
  variant?: 'main' | 'viewer' | 'compose';
}

export function MenuBar({ variant = 'main' }: MenuBarProps) {
  const categories =
    variant === 'compose'
      ? getComposeCategories()
      : variant === 'viewer'
        ? VIEWER_CATEGORIES
        : MAIN_CATEGORIES;
  const activeCategory = useUIStore((s) => s.activeMenuCategory);
  const setActiveCategory = useUIStore((s) => s.setActiveMenuCategory);
  const ref = useRef<HTMLDivElement>(null);
  const { active, scheduleClose, cancelClose, open, setActive } = useMenuHoverState<string>();

  // Sync external store state with local hover state
  useEffect(() => {
    setActive(activeCategory);
  }, [activeCategory, setActive]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setActiveCategory(null);
      }
    }

    if (activeCategory) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [activeCategory, setActiveCategory]);

  const closeMenu = useCallback(() => setActiveCategory(null), [setActiveCategory]);

  return (
    <div ref={ref} className="flex items-center ml-1">
      {categories.map((category) => {
        const isActive = active === category.label;
        return (
          <div
            key={category.label}
            className="relative"
            onMouseEnter={() => open(category.label)}
            onMouseLeave={scheduleClose}
          >
            <button
              type="button"
              onClick={() => setActiveCategory(isActive ? null : category.label)}
              className={`px-3 py-1 text-sm rounded transition-colors ${
                isActive
                  ? 'bg-[var(--selected)] text-[var(--primary)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
              }`}
            >
              {category.label}
            </button>

            {isActive && (
              <div
                className="absolute top-full left-0 w-56 z-50"
                onMouseEnter={cancelClose}
                onMouseLeave={scheduleClose}
              >
                {category.customContent && category.label === 'View' ? (
                  <div className="bg-[var(--surface)] border border-[var(--border)] shadow-lg rounded py-1">
                    <ViewMenu />
                  </div>
                ) : (
                  <MenuDropdown items={category.items as MenuItemData[]} onClose={closeMenu} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
