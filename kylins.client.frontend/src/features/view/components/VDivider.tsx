import { Separator } from 'react-resizable-panels';

/**
 * Vertical drag handle — a wider rounded bar. react-resizable-panels expands the
 * drag hit region to at least 10px (fine pointer) regardless of visual width,
 * so the bar can stay slim-looking while remaining easy to grab.
 */
export function VDivider({ invisible = false }: { invisible?: boolean }) {
  if (invisible) {
    // 1px transparent divider between FolderPane and MessageList, inset on
    // the message-list side only so the library's ≥10px drag hit region sits
    // away from the message-list colorbar without adding left-side space.
    return <Separator className="mr-2 w-px bg-transparent" />;
  }
  return (
    <Separator className="mx-1 w-1.5 rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--series-300)]" />
  );
}
