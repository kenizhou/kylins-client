import { Separator } from 'react-resizable-panels';

/**
 * Vertical drag handle — a wider rounded bar. react-resizable-panels expands the
 * drag hit region to at least 10px (fine pointer) regardless of visual width,
 * so the bar can stay slim-looking while remaining easy to grab.
 */
export function VDivider({ invisible = false }: { invisible?: boolean }) {
  if (invisible) {
    // 1px transparent divider between FolderPane and MessageList. The
    // resizable-panels library keeps a ≥10px drag hit region regardless of
    // visual width, so resizing stays easy.
    return <Separator className="w-px bg-transparent" />;
  }
  return (
    <Separator className="mx-1 w-1.5 rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--series-300)]" />
  );
}
