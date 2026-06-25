// Lightweight, reusable right-click context menu rendered in a portal at the
// cursor position. Mirrors the pattern Velo uses (ContextMenuPortal). Dismisses
// on outside click, Escape, or item selection.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

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
      className="min-w-[180px] py-1 rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg"
      role="menu"
    >
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={i} className="my-1 border-t border-[var(--border)]" />;
        }
        const Icon = item.icon;
        return (
          <button
            key={i}
            type="button"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose();
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
              item.disabled
                ? 'cursor-default text-[var(--muted-text)] opacity-50'
                : item.danger
                  ? 'text-red-600 hover:bg-[var(--hover)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
            }`}
            role="menuitem"
          >
            {Icon && <Icon size={14} />}
            <span className="flex-1 truncate">{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
