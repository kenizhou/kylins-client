import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { MenuItem } from './MenuItem';
import { ViewMenu } from '../../features/view/components/ViewMenu';

interface MenuItemData {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick?: () => void;
}

interface MenuCategoryData {
  label: string;
  items: MenuItemData[] | React.ReactNode;
  customContent?: boolean;
}

const MENU_CATEGORIES: MenuCategoryData[] = [
  {
    label: 'File',
    items: [
      { label: 'New Mail', shortcut: 'Ctrl+N' },
      {
        label: 'Add account…',
        onClick: () => {
          useUIStore.getState().setActiveMenuCategory(null);
          useUIStore.getState().setAccountSetupOpen(true);
        },
      },
      { label: 'New Window', disabled: true },
      { label: 'Close Window', disabled: true },
      { label: 'Exit', disabled: true },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', disabled: true },
      { label: 'Redo', shortcut: 'Ctrl+Y', disabled: true },
      { label: 'Cut', shortcut: 'Ctrl+X', disabled: true },
      { label: 'Copy', shortcut: 'Ctrl+C', disabled: true },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: true },
    ],
  },
  {
    label: 'View',
    items: [],
    customContent: true,
  },
  {
    label: 'Go',
    items: [
      { label: 'Mail' },
      { label: 'Calendar', disabled: true },
      { label: 'Contacts', disabled: true },
      { label: 'Tasks', disabled: true },
      { label: 'AI Assistant', disabled: true },
    ],
  },
  {
    label: 'Tools',
    items: [{ label: 'Settings' }, { label: 'Accounts' }, { label: 'Plugins', disabled: true }],
  },
  {
    label: 'Help',
    items: [
      { label: 'Documentation', disabled: true },
      { label: 'About', disabled: true },
    ],
  },
];

export function MenuBar() {
  const activeCategory = useUIStore((s) => s.activeMenuCategory);
  const setActiveCategory = useUIStore((s) => s.setActiveMenuCategory);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const scheduleClose = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
    }
    closeTimeoutRef.current = setTimeout(() => {
      setActiveCategory(null);
    }, 100);
  };

  const cancelClose = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const openCategory = (label: string) => {
    cancelClose();
    setActiveCategory(label);
  };

  return (
    <div ref={ref} className="flex items-center ml-1">
      {MENU_CATEGORIES.map((category) => {
        const active = activeCategory === category.label;
        return (
          <div
            key={category.label}
            className="relative"
            onMouseEnter={() => openCategory(category.label)}
            onMouseLeave={scheduleClose}
          >
            <button
              type="button"
              onClick={() => setActiveCategory(active ? null : category.label)}
              className={`px-3 py-1 text-sm rounded transition-colors ${
                active
                  ? 'bg-[var(--selected)] text-[var(--primary)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
              }`}
            >
              {category.label}
            </button>

            {active && (
              <div
                className="absolute top-full left-0 w-56 bg-[var(--surface)] border border-[var(--border)] shadow-lg rounded py-1 z-50"
                onMouseEnter={cancelClose}
                onMouseLeave={scheduleClose}
              >
                {category.customContent && category.label === 'View' ? (
                  <ViewMenu />
                ) : (
                  (category.items as MenuItemData[]).map((item) => (
                    <MenuItem
                      key={item.label}
                      label={item.label}
                      shortcut={item.shortcut}
                      disabled={item.disabled}
                      onClick={item.onClick}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
