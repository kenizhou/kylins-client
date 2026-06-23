interface MenuItemProps {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  hasSubmenu?: boolean;
  onClick?: () => void;
}

export function MenuItem({
  label,
  shortcut,
  disabled = false,
  checked = false,
  hasSubmenu = false,
  onClick,
}: MenuItemProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full flex items-center justify-between px-3 py-1.5 text-sm text-[var(--foreground)] hover:bg-[var(--hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      <span className="flex items-center gap-2">
        <span className="w-4 inline-flex justify-center">{checked ? '✓' : ''}</span>
        <span>{label}</span>
      </span>
      <span className="flex items-center gap-2">
        {shortcut && <span className="text-xs text-[var(--muted-text)]">{shortcut}</span>}
        {hasSubmenu && <span className="text-xs text-[var(--muted-text)]">▶</span>}
      </span>
    </button>
  );
}
