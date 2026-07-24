import { useState } from 'react';
import { Button } from 'react-aria-components';
import type { MailMessage } from '@/features/view/viewStore';
import { ReplyFilledIcon, ReplyAllFilledIcon, MailSendIcon } from '@/components/icons';
import { SecurityChips } from '@/features/classification/components/SecurityChips';
import { IconButton } from '@/components/ui/IconButton';
import { formatFullDate, formatDateTimeMinutes } from '@/utils/formatDate';
import { getInitials } from '@/data/demoMessages';
import { avatarGradient } from '@/utils/avatarGradient';

interface MessageHeaderProps {
  message: MailMessage;
  extraActions?: React.ReactNode;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onAddContact: () => void;
  contactAdded: boolean;
}

function formatRecipient(r: { name: string; address: string }): string {
  return r.name && r.name !== r.address ? `${r.name} <${r.address}>` : r.address;
}

function recipientSummary(
  to: { name: string; address: string }[] | undefined,
  cc: { name: string; address: string }[] | undefined,
): string {
  const toCount = to?.length ?? 0;
  const ccCount = cc?.length ?? 0;
  if (toCount === 0 && ccCount === 0) return 'No recipients';
  const parts: string[] = [];
  if (toCount > 0) parts.push(`${toCount} recipient${toCount === 1 ? '' : 's'}`);
  if (ccCount > 0) parts.push(`Cc ${ccCount}`);
  return parts.join(', ');
}

export function MessageHeader({
  message,
  extraActions,
  onReply,
  onReplyAll,
  onForward,
  onAddContact,
  contactAdded,
}: MessageHeaderProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="reading-pane-header border-b border-[var(--border-subtle)] px-5 pt-4 pb-3">
      <h1 className="reading-pane-subject min-w-0 text-[20px] font-semibold leading-[1.3] tracking-[-0.01em] text-[var(--text)]">
        {message.subject}
      </h1>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <SecurityChips
          isEncrypted={message.isEncrypted}
          isSigned={message.isSigned}
          variant="label"
          size={12}
        />
      </div>

      <div className="reading-pane-sender-row mt-3 flex items-stretch gap-3">
        <div className="flex min-w-[220px] flex-1 items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold shadow-[var(--shadow-sm)]"
            style={{
              background: avatarGradient(message.from.name).background,
              color: avatarGradient(message.from.name).foreground,
            }}
            aria-hidden="true"
          >
            {getInitials(message.from.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-semibold text-[var(--text)]">{message.from.name}</span>
              <Button
                type="button"
                onPress={onAddContact}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--primary-subtle)] px-2 py-0.5 text-[10px] font-medium text-primary transition-opacity hover:opacity-90"
              >
                {/* RAC Button strips `title`; keep the tooltip on a wrapper. */}
                <span title="Add sender to contacts" className="inline-flex items-center">
                  {contactAdded ? 'Saved' : 'Add to contacts'}
                </span>
              </Button>
            </div>
            <div className="mt-0.5 truncate text-sm text-[var(--muted-text)]">
              {message.from.address}
            </div>

            <Button
              type="button"
              onPress={() => setExpanded((e) => !e)}
              className="mt-0.5 flex flex-col items-start gap-0.5 text-left text-sm text-[var(--muted-text)] hover:text-[var(--foreground)]"
              aria-expanded={expanded}
            >
              <span className="whitespace-nowrap">
                <span className="text-[var(--muted-text)]">To:</span>{' '}
                <span className="text-[var(--text)]">
                  {recipientSummary(message.to, message.cc)}
                </span>
                <span className="ml-1 text-[10px]">{expanded ? '▲' : '▼'}</span>
              </span>
              {expanded && (
                <span className="mt-0.5 flex flex-col gap-0.5 text-xs">
                  {(message.to ?? []).length > 0 && (
                    <span>
                      <span className="text-[var(--muted-text)]">To:</span>{' '}
                      {message.to!.map(formatRecipient).join('; ')}
                    </span>
                  )}
                  {(message.cc ?? []).length > 0 && (
                    <span>
                      <span className="text-[var(--muted-text)]">Cc:</span>{' '}
                      {message.cc!.map(formatRecipient).join('; ')}
                    </span>
                  )}
                </span>
              )}
            </Button>
          </div>
        </div>

        <div className="reading-pane-actions ml-auto flex shrink-0 flex-col items-end justify-between">
          <div className="flex flex-wrap items-center justify-end gap-1">
            <IconButton
              size="md"
              label="Reply"
              title="Reply"
              className="reading-pane-action-button"
              onClick={onReply}
              icon={
                <span className="text-[var(--primary)]">
                  <ReplyFilledIcon size={18} />
                </span>
              }
            />
            <IconButton
              size="md"
              label="Reply all"
              title="Reply all"
              className="reading-pane-action-button"
              onClick={onReplyAll}
              icon={
                <span className="text-[var(--primary)]">
                  <ReplyAllFilledIcon size={18} />
                </span>
              }
            />
            <IconButton
              size="md"
              label="Forward"
              title="Forward"
              className="reading-pane-action-button"
              onClick={onForward}
              icon={
                <span className="text-[var(--primary)]">
                  <MailSendIcon size={18} />
                </span>
              }
            />

            {extraActions}
          </div>
          <span className="group/tooltip relative whitespace-nowrap type-caption tabular-nums text-[var(--muted-text)]">
            {formatDateTimeMinutes(message.date)}
            <span className="pointer-events-none absolute bottom-full right-0 mb-1 whitespace-nowrap rounded bg-[var(--foreground)] px-2 py-1 text-[10px] text-[var(--background)] opacity-0 transition-opacity group-hover/tooltip:opacity-100">
              {formatFullDate(message.date)}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
