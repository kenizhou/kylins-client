import { Button } from 'react-aria-components';
import { SendIcon, SpinnerIcon, TrashIcon, ClockIcon } from '../../icons';

export interface ComposerActionsRowProps {
  canSend: boolean;
  sending: boolean;
  onSend: () => void;
  onDiscard: () => void;
  onSchedule: () => void;
}

/**
 * Outlook-style send actions row: left-aligned above the recipient fields of
 * the composer pop-out window. Replaces the old panel footer's buttons.
 */
export function ComposerActionsRow({
  canSend,
  sending,
  onSend,
  onDiscard,
  onSchedule,
}: ComposerActionsRowProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5">
      <Button
        onPress={onSend}
        isDisabled={!canSend || sending}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-fg)] shadow-[var(--shadow-sm)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {sending ? <SpinnerIcon size={14} /> : <SendIcon size={14} />}
        {sending ? 'Sending…' : 'Send'}
      </Button>
      <Button
        onPress={onSchedule}
        isDisabled={sending}
        className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
      >
        <ClockIcon size={14} />
        Schedule
      </Button>
      <Button
        onPress={onDiscard}
        isDisabled={sending}
        className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-50"
      >
        <TrashIcon size={14} />
        Discard
      </Button>
    </div>
  );
}
