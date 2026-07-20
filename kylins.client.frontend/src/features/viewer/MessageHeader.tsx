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

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function senderGradient(name: string): string {
  const hue = hashString(name) % 360;
  return `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 45%))`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(((n + h / 30) % 12) - 3, 9 - ((n + h / 30) % 12), 1));
  return [f(0), f(8), f(4)];
}

function luminance(r: number, g: number, b: number): number {
  const values = [r, g, b].map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * (values[0] ?? 0) + 0.7152 * (values[1] ?? 0) + 0.0722 * (values[2] ?? 0);
}

function avatarTextColor(name: string): string {
  const hue = hashString(name) % 360;
  const [r, g, b] = hslToRgb(hue, 70, 55);
  return luminance(r, g, b) > 0.55 ? '#0f172a' : '#ffffff';
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
      <h1 className="reading-pane-subject min-w-0 text-[22px] font-semibold leading-[1.25] tracking-tight text-[var(--text)]">
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
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold shadow-sm"
            style={{
              background: senderGradient(message.from.name),
              color: avatarTextColor(message.from.name),
            }}
            aria-hidden="true"
          >
            {getInitials(message.from.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-semibold text-[var(--text)]">{message.from.name}</span>
              <span className="text-sm text-[var(--muted-text)]">{message.from.address}</span>
              <button
                type="button"
                onClick={onAddContact}
                className="inline-flex items-center gap-1 rounded bg-[var(--primary-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--foreground)] transition-opacity hover:opacity-90"
                title="Add sender to contacts"
              >
                {contactAdded ? 'Saved' : 'Add to contacts'}
              </button>
            </div>

            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="mt-0.5 flex flex-col items-start gap-0.5 text-left text-sm text-[var(--muted-text)] hover:text-[var(--foreground)]"
              aria-expanded={expanded}
            >
              <span>
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
            </button>

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
            <Popover className="min-w-[180px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
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
