import { type ReactNode, useState } from 'react';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import {
  SmileIcon,
  ReplyFilledIcon,
  ReplyAllFilledIcon,
  ForwardFilledIcon,
  MoreIcon,
  ArchiveIcon,
  DeleteIcon,
} from '../icons';
import { useViewStore } from '../../features/view/viewStore';
import { useAccountStore } from '../../stores/accountStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { EmailRenderer } from '../email/EmailRenderer';
import { InlineReply } from '../email/InlineReply';
import { formatFullDate } from '../../utils/formatDate';
import { getInitials } from '../../data/demoMessages';

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

function recipientList(recipients: { name: string; address: string }[]): string {
  if (recipients.length === 0) return '';
  const first = recipients[0]!;
  if (recipients.length === 1) return `${first.name} <${first.address}>`;
  return `${first.name} <${first.address}> +${recipients.length - 1} more`;
}

function SubjectActionButton({
  icon,
  title,
  onClick,
  className,
}: {
  icon: ReactNode;
  title: string;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--hover)] ${
        className ?? 'text-[var(--muted-text)] hover:text-[var(--foreground)]'
      }`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export function ReadingPane() {
  const message = useViewStore((s) => s.selectedMessage);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const accountEmail = accounts.find((a) => a.id === activeAccountId)?.email ?? null;
  const automaticallyLoadImages = usePreferencesStore((s) => s.automaticallyLoadImages);
  const [composeMode, setComposeMode] = useState<'reply' | 'replyAll' | 'forward' | null>(null);
  // Reset the inline composer when the selected message changes. Uses the
  // prev-value render pattern (setState-during-render to correct stale state)
  // rather than setState-in-effect.
  const [activeMsgId, setActiveMsgId] = useState<string | undefined>(message?.id);
  if (message?.id !== activeMsgId) {
    setActiveMsgId(message?.id);
    setComposeMode(null);
  }

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

  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--card)]">
      <div className="border-b border-[var(--border)] px-5 pt-4 pb-3">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h1 className="min-w-0 flex-1 text-[22px] font-semibold leading-[1.25] tracking-tight text-[var(--text)]">
            {message.subject}
          </h1>
          <div className="mt-0.5 flex shrink-0 items-center gap-1">
            <SubjectActionButton
              icon={<ReplyFilledIcon size={18} />}
              title="Reply"
              onClick={handleReply}
              className="text-[var(--primary)]"
            />
            <SubjectActionButton
              icon={<ReplyAllFilledIcon size={18} />}
              title="Reply all"
              onClick={handleReplyAll}
              className="text-[var(--primary)]"
            />
            <SubjectActionButton
              icon={<ForwardFilledIcon size={18} />}
              title="Forward"
              onClick={handleForward}
              className="text-[var(--primary)]"
            />
            <div className="mx-1 h-4 w-px bg-[var(--border)]" />
            <SubjectActionButton icon={<ArchiveIcon size={17} />} title="Archive" />
            <SubjectActionButton icon={<DeleteIcon size={17} />} title="Delete" />
            <SubjectActionButton icon={<SmileIcon size={17} />} title="React" />
            <SubjectActionButton icon={<MoreIcon size={17} />} title="More actions" />
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white shadow-sm"
            style={{ background: senderGradient(message.from.name) }}
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
      </div>

      <main className="flex-1 overflow-auto p-5 leading-[1.6] text-[var(--text)]">
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
      <InjectedComponentSet role="reading-pane:footer" containersRequired={false} />
    </div>
  );
}

function MailIcon({ size }: { size?: number }) {
  // Inline fallback so ReadingPane doesn't depend on the full icon set just for the empty state.
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 7.5L12 13l8.5-5.5" />
    </svg>
  );
}
