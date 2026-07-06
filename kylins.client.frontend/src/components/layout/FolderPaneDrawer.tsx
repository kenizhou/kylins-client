import { useEffect, useRef } from 'react';

/**
 * Compact-width slide-in folder pane. Announced as a modal dialog and closes
 * on Escape or backdrop click.
 */
export function FolderPaneDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }

    // Move focus into the drawer for keyboard users.
    ref.current?.focus({ preventScroll: true });
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[var(--z-sticky)]"
      onClick={(e) => {
        // Close when clicking the backdrop, not the drawer itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-label="Folder pane"
        aria-modal="true"
        tabIndex={-1}
        className="folder-pane-drawer open outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
