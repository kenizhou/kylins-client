import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import {
  ArrowBendDoubleUpLeft,
  ArrowBendUpLeft,
  ArrowBendUpRight,
  Archive,
} from '@phosphor-icons/react';
import { MoreIcon, DeleteIcon, FlagIcon, MailIcon } from '../icons';
import { IconButton } from '../ui/IconButton';
import { useViewStore } from '../../features/view/viewStore';
import { useAccountStore } from '../../stores/accountStore';
import { useThreadStore } from '../../stores/threadStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { EmailRenderer } from '../email/EmailRenderer';
import { InlineReply } from '../email/InlineReply';
import { formatFullDate } from '../../utils/formatDate';
import { getInitials } from '../../data/demoMessages';
import { useClassification } from '../../features/classification/useClassification';
import { isProminent, levelStyle } from '../../features/classification/classificationStyle';
import { ClassificationBanner } from '../../features/classification/components/ClassificationBanner';
import { ClassificationWatermark } from '../../features/classification/components/ClassificationWatermark';
import { ClassificationBadge } from '../../features/classification/components/ClassificationBadge';
import { SecurityChips } from '../../features/classification/components/SecurityChips';

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

function recipientList(recipients: { name: string; address: string }[]): string {
  if (recipients.length === 0) return '';
  const first = recipients[0]!;
  if (recipients.length === 1) return `${first.name} <${first.address}>`;
  return `${first.name} <${first.address}> +${recipients.length - 1} more`;
}

interface MoreActionsMenuProps {
  x: number;
  y: number;
  isRead?: boolean;
  disabled?: boolean;
  onToggleRead: () => void;
  onClose: () => void;
}

function MoreActionsMenu({ x, y, isRead, disabled, onToggleRead, onClose }: MoreActionsMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg"
      style={{ left: x, top: y, zIndex: 'var(--z-dropdown)' }}
    >
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => {
          onToggleRead();
          onClose();
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <MailIcon size={16} />
        <span>{isRead ? 'Mark as unread' : 'Mark as read'}</span>
      </button>
    </div>,
    document.body,
  );
}

export function ReadingPane() {
  const message = useViewStore((s) => s.selectedMessage);
  const selectedThread = useThreadStore((s) => s.threads.find((t) => t.id === message?.threadId));
  const markThreadRead = useThreadStore((s) => s.markThreadRead);
  const toggleThreadStarred = useThreadStore((s) => s.toggleThreadStarred);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const accountEmail = accounts.find((a) => a.id === activeAccountId)?.email ?? null;
  const automaticallyLoadImages = usePreferencesStore((s) => s.automaticallyLoadImages);
  const { getLevelById } = useClassification();
  const [composeMode, setComposeMode] = useState<'reply' | 'replyAll' | 'forward' | null>(null);
  // Reset the inline composer when the selected message changes. Uses the
  // prev-value render pattern (setState-during-render to correct stale state)
  // rather than setState-in-effect.
  const [activeMsgId, setActiveMsgId] = useState<string | undefined>(message?.id);
  if (message?.id !== activeMsgId) {
    setActiveMsgId(message?.id);
    setComposeMode(null);
  }

  const [moreOpen, setMoreOpen] = useState(false);
  const [morePos, setMorePos] = useState<{ x: number; y: number } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  if (!message) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--card)] min-w-0 text-[var(--muted-text)]">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--muted-text)]">
            <MailIcon size={24} />
          </div>
          <p className="text-lg font-medium text-[var(--foreground)]">No message selected</p>
          <p className="mt-1 text-sm">Select a message from the list to read it here.</p>
        </div>
        <InjectedComponentSet role="reading-pane:footer" containersRequired={false} />
      </div>
    );
  }

  // Inline reply / forward (Outlook-style) takes over the reading pane.
  if (composeMode) {
    return (
      <InlineReply
        message={message}
        mode={composeMode}
        accountId={activeAccountId}
        accountEmail={accountEmail}
        onClose={() => setComposeMode(null)}
        onSent={() => setComposeMode(null)}
      />
    );
  }

  const handleReply = () => setComposeMode('reply');
  const handleReplyAll = () => setComposeMode('replyAll');
  const handleForward = () => setComposeMode('forward');

  const isSuspicious = message.subject.toLowerCase().includes('verify your account');

  const level = message.classificationId ? getLevelById(message.classificationId) : undefined;
  const prominent = level ? isProminent(level) : false;
  const style = level ? levelStyle(level) : null;

  const handleToggleMore = () => {
    if (!moreOpen && moreButtonRef.current) {
      const rect = moreButtonRef.current.getBoundingClientRect();
      setMorePos({
        x: Math.max(8, rect.right - 160),
        y: rect.bottom + 4,
      });
    }
    setMoreOpen((v) => !v);
  };

  const handleMarkRead = () => {
    if (selectedThread) {
      void markThreadRead(selectedThread, !selectedThread.isRead);
    }
  };

  const handleStar = () => {
    if (selectedThread) void toggleThreadStarred(selectedThread);
  };

  const handleDelete = () => {
    if (selectedThread) void deleteThread(selectedThread);
  };

  return (
    <div className="reading-pane relative flex h-full min-w-0 flex-col bg-[var(--card)]">
      {prominent && level && <ClassificationBanner level={level} position="top" />}

      <div
        className="reading-pane-header border-b border-[var(--border)] px-5 pt-4 pb-3"
        style={prominent && style ? { backgroundColor: style.tint } : undefined}
      >
        <h1 className="reading-pane-subject min-w-0 text-[22px] font-semibold leading-[1.25] tracking-tight text-[var(--text)]">
          {message.subject}
        </h1>

        {level && (
          <div className="mt-2 flex items-center gap-2">
            <ClassificationBadge level={level} />
            <SecurityChips
              isEncrypted={message.isEncrypted}
              isSigned={message.isSigned}
              variant="label"
            />
            {message.preventCopy && (
              <span className="text-[11px] text-[var(--muted-text)]">Prevent Copy</span>
            )}
            {message.readReceiptRequested && (
              <span className="text-[11px] text-[var(--muted-text)]">Read Receipt</span>
            )}
          </div>
        )}

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
              </div>
              <div className="mt-0.5 text-sm text-[var(--muted-text)]">
                <span className="text-[var(--muted-text)]">To:</span>{' '}
                <span className="text-[var(--text)]">{recipientList(message.to)}</span>
              </div>
              <div className="mt-0.5 text-xs text-[var(--muted-text)]">
                {formatFullDate(message.date)}
              </div>
            </div>
          </div>

          <div className="reading-pane-actions mt-0.5 flex flex-wrap items-center gap-1 shrink-0">
            <IconButton
              size="md"
              label="Reply"
              title="Reply"
              onClick={handleReply}
              icon={
                <span className="text-[var(--primary)]">
                  <ArrowBendUpLeft size={18} weight="bold" />
                </span>
              }
            />
            <IconButton
              size="md"
              label="Reply all"
              title="Reply all"
              onClick={handleReplyAll}
              icon={
                <span className="text-[var(--primary)]">
                  <ArrowBendDoubleUpLeft size={18} weight="bold" />
                </span>
              }
            />
            <IconButton
              size="md"
              label="Forward"
              title="Forward"
              onClick={handleForward}
              icon={
                <span className="text-[var(--primary)]">
                  <ArrowBendUpRight size={18} weight="bold" />
                </span>
              }
            />
            <div className="mx-1 h-4 w-px bg-[var(--border)]" />
            <IconButton size="sm" title="Archive" onClick={() => {}} icon={<Archive size={18} />} />
            <IconButton
              size="sm"
              title={selectedThread?.isStarred ? 'Remove flag' : 'Flag'}
              onClick={handleStar}
              className={
                selectedThread?.isStarred
                  ? 'text-[var(--amber)] hover:text-[var(--amber)]'
                  : undefined
              }
              icon={<FlagIcon size={17} />}
            />
            <IconButton
              size="sm"
              title="Delete"
              onClick={handleDelete}
              icon={<DeleteIcon size={17} />}
            />
            <IconButton
              ref={moreButtonRef}
              size="sm"
              title="More actions"
              onClick={handleToggleMore}
              icon={<MoreIcon size={17} />}
            />
            {moreOpen && morePos && (
              <MoreActionsMenu
                x={morePos.x}
                y={morePos.y}
                isRead={selectedThread?.isRead}
                disabled={!selectedThread}
                onToggleRead={handleMarkRead}
                onClose={() => setMoreOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      <main
        className="relative flex-1 overflow-auto p-5 leading-[1.6] text-[var(--text)]"
        style={message.preventCopy ? { userSelect: 'none' } : undefined}
        onContextMenu={message.preventCopy ? (e) => e.preventDefault() : undefined}
      >
        {prominent && level && <ClassificationWatermark level={level} identity={accountEmail} />}
        <EmailRenderer
          html={message.html}
          text={message.text}
          blockImages={!automaticallyLoadImages}
          senderAddress={message.from.address}
          accountId={activeAccountId}
          senderAllowlisted={false}
          isMessageSuspicious={isSuspicious}
          cidMap={null}
        />
      </main>
      {prominent && level && <ClassificationBanner level={level} position="bottom" />}
      <InjectedComponentSet role="reading-pane:footer" containersRequired={false} />
    </div>
  );
}
