import { useState } from 'react';
import { Button, Popover, Menu, MenuItem, DialogTrigger } from 'react-aria-components';
import type { MailMessage } from '@/features/view/viewStore';
import {
  ReplyFilledIcon,
  ReplyAllFilledIcon,
  MailSendIcon,
  MoreIcon,
  ArchiveIcon,
  DeleteIcon,
  WarningIcon,
  MailIcon,
} from '@/components/icons';
import { SecurityChips } from '@/features/classification/components/SecurityChips';
import { IconButton } from '@/components/ui/IconButton';
import { formatFullDate } from '@/utils/formatDate';
import { getInitials, formatMessageTime } from '@/data/demoMessages';
import { avatarGradient } from '@/utils/avatarGradient';

interface MessageHeaderProps {
  message: MailMessage;
  extraActions?: React.ReactNode;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onJunk: () => void;
  onMarkUnread: () => void;
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
  onArchive,
  onDelete,
  onJunk,
  onMarkUnread,
  onAddContact,
  contactAdded,
}: MessageHeaderProps) {
  const [expanded, setExpanded] = useState(false);

  const menuItems = [
    { key: 'reply', label: 'Reply', icon: <ReplyFilledIcon size={14} />, onAction: onReply },
    {
      key: 'replyAll',
      label: 'Reply all',
      icon: <ReplyAllFilledIcon size={14} />,
      onAction: onReplyAll,
    },
    { key: 'forward', label: 'Forward', icon: <MailSendIcon size={14} />, onAction: onForward },
    { key: 'archive', label: 'Archive', icon: <ArchiveIcon size={14} />, onAction: onArchive },
    { key: 'delete', label: 'Delete', icon: <DeleteIcon size={14} />, onAction: onDelete },
    { key: 'junk', label: 'Junk', icon: <WarningIcon size={14} />, onAction: onJunk },
    { key: 'unread', label: 'Mark unread', icon: <MailIcon size={14} />, onAction: onMarkUnread },
  ];

  return (
    <div className="reading-pane-header border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-5 pt-4 pb-3">
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

      <div className="reading-pane-sender-row mt-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
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

            <span className="group/tooltip relative mt-0.5 text-xs text-[var(--muted-text)]">
              {formatMessageTime(message.date)}
              <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--foreground)] px-2 py-1 text-[10px] text-[var(--background)] opacity-0 transition-opacity group-hover/tooltip:opacity-100">
                {formatFullDate(message.date)}
              </span>
            </span>
          </div>
        </div>

        <div className="reading-pane-actions mt-0.5 flex flex-wrap items-center gap-1 shrink-0">
          <IconButton
            size="md"
            label="Reply"
            title="Reply"
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
            onClick={onForward}
            icon={
              <span className="text-[var(--primary)]">
                <MailSendIcon size={18} />
              </span>
            }
          />

          <DialogTrigger>
            <Button
              aria-label="More actions"
              className="inline-flex h-8 w-8 items-center justify-center rounded text-[var(--muted-text)] transition-colors hover:bg-[var(--primary-subtle)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              <MoreIcon size={18} />
            </Button>
            <Popover className="min-w-[180px] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-[var(--shadow-lg)]">
              <Menu
                aria-label="More actions"
                items={menuItems}
                onAction={(key) => menuItems.find((i) => i.key === key)?.onAction()}
                className="outline-none"
              >
                {(item) => (
                  <MenuItem
                    id={item.key}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none hover:bg-[var(--primary-subtle)] focus-visible:bg-[var(--primary-subtle)]"
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </MenuItem>
                )}
              </Menu>
            </Popover>
          </DialogTrigger>
          {extraActions}
        </div>
      </div>
    </div>
  );
}
