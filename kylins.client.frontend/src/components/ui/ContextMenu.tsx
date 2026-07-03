// Lightweight, reusable right-click context menu rendered in a portal at the
// cursor position. Uses react-aria-components for keyboard navigation and ARIA.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Menu, MenuItem, Separator } from 'react-aria-components';

export interface ContextMenuItem {
  label?: string;
  icon?: React.ComponentType<{ size?: number }>;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onWindowBlur() {
      onClose();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [onClose]);

  // Best-effort viewport clamping so the menu never renders off-screen.
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 32 - 16),
    zIndex: 80,
  };

  return createPortal(
    <div
      ref={ref}
      style={style}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="min-w-[180px] rounded-md border border-border bg-surface py-1 shadow-lg"
    >
      <Menu aria-label="Context menu" className="outline-none">
        {items.map((item, i) => {
          if (item.separator) {
            return <Separator key={`sep-${i}`} className="my-1 border-t border-border" />;
          }
          const Icon = item.icon;
          return (
            <MenuItem
              key={item.label ?? i}
              id={item.label ?? i}
              isDisabled={item.disabled}
              textValue={item.label}
              onAction={() => {
                item.onSelect?.();
                onClose();
              }}
              className={({ isFocused, isHovered, isDisabled }) =>
                `flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] focus-visible:outline-none ${
                  isDisabled
                    ? 'cursor-default text-muted-text opacity-50'
                    : item.danger
                      ? `text-red-600 ${isFocused || isHovered ? 'bg-hover' : ''}`
                      : `cursor-pointer text-foreground ${isFocused || isHovered ? 'bg-hover' : ''}`
                }`
              }
            >
              {Icon && <Icon size={14} />}
              <span className="flex-1 truncate">{item.label}</span>
            </MenuItem>
          );
        })}
      </Menu>
    </div>,
    document.body,
  );
}
