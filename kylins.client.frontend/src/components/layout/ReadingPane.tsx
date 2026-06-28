import { type ReactNode, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { ArrowBendDoubleUpLeft, Archive } from '@phosphor-icons/react';
import {
  CornerUpLeftIcon,
  CornerUpRightIcon,
  MoreIcon,
  DeleteIcon,
  FlagIcon,
  ClassificationIcon,
} from '../icons';
import { useViewStore } from '../../features/view/viewStore';
import { useAccountStore } from '../../stores/accountStore';
import { useThreadStore } from '../../stores/threadStore';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { EmailRenderer } from '../email/EmailRenderer';
import { InlineReply } from '../email/InlineReply';
import { formatFullDate } from '../../utils/formatDate';
import { getInitials } from '../../data/demoMessages';
import { useClassification } from '../../features/classification/useClassification';
import { useSecurityIndicatorIcons } from '../../features/classification/useSecurityIndicatorIcons';

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

function SubjectActionTextButton({
  icon,
  label,
  title,
  onClick,
  className,
  labelClassName,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  onClick?: () => void;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 h-8 whitespace-nowrap text-sm font-medium rounded-md transition-colors hover:bg-[var(--hover)] ${
        className ?? 'text-[var(--muted-text)] hover:text-[var(--foreground)]'
      }`}
    >
      {icon}
      <span className={labelClassName ?? 'hidden sm:inline'}>{label}</span>
    </button>
  );
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
  const selectedThread = useThreadStore((s) => s.threads.find((t) => t.id === message?.threadId));
  const markThreadRead = useThreadStore((s) => s.markThreadRead);
  const toggleThreadStarred = useThreadStore((s) => s.toggleThreadStarred);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const accountEmail = accounts.find((a) => a.id === activeAccountId)?.email ?? null;
  const automaticallyLoadImages = usePreferencesStore((s) => s.automaticallyLoadImages);
  const { getLevelById } = useClassification();
  const { encryptedIcon, signedIcon } = useSecurityIndicatorIcons();
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
  const isConfidential = level?.id === 'confidential';

  return (
    <div className="reading-pane flex h-full min-w-0 flex-col bg-[var(--card)]">
      <div
        className="reading-pane-header border-b border-[var(--border)] px-5 pt-4 pb-3"
        style={{
          borderTopWidth: '4px',
          borderTopColor: level?.color ?? 'transparent',
          backgroundColor: isConfidential ? `${level?.color}10` : undefined,
        }}
      >
        <h1 className="reading-pane-subject min-w-0 text-[22px] font-semibold leading-[1.25] tracking-tight text-[var(--text)]">
          {message.subject}
        </h1>

        {level && (
          <div className="mt-2 flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 rounded border px-2.5 py-0.5 text-xs font-medium"
              style={{
                borderColor: level.color,
                color: level.color,
                backgroundColor: `${level.color}15`,
              }}
            >
              <ClassificationIcon icon={level.icon} size={12} />
              {!level.icon && (
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: level.color }}
                />
              )}
              {level.name}
            </span>
            {(message.isEncrypted || message.isSigned) && (
              <span className="inline-flex items-center gap-1 text-[var(--muted-text)]">
                {message.isEncrypted && (
                  <span className="inline-flex items-center gap-0.5 text-[11px]">
                    <ClassificationIcon icon={encryptedIcon} size={12} />
                    Encrypted
                  </span>
                )}
                {message.isSigned && (
                  <span className="inline-flex items-center gap-0.5 text-[11px]">
                    <ClassificationIcon icon={signedIcon} size={12} />
                    Signed
                  </span>
                )}
              </span>
            )}
          </div>
        )}

        <div className="reading-pane-sender-row mt-3 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
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

          <div className="reading-pane-actions mt-0.5 flex flex-wrap items-center gap-1 shrink-0">
            <SubjectActionTextButton
              icon={
                <span className="text-[var(--primary)]">
                  <HugeiconsIcon icon={CornerUpLeftIcon} size={18} strokeWidth={2} />
                </span>
              }
              label="Reply"
              title="Reply"
              onClick={handleReply}
              labelClassName="reading-pane-action-label"
            />
            <SubjectActionTextButton
              icon={
                <span className="text-[var(--primary)]">
                  <ArrowBendDoubleUpLeft size={18} weight="bold" />
                </span>
              }
              label="Reply all"
              title="Reply all"
              onClick={handleReplyAll}
              labelClassName="reading-pane-action-label"
            />
            <SubjectActionTextButton
              icon={
                <span className="text-[var(--primary)]">
                  <HugeiconsIcon icon={CornerUpRightIcon} size={18} strokeWidth={2} />
                </span>
              }
              label="Forward"
              title="Forward"
              onClick={handleForward}
              labelClassName="reading-pane-action-label"
            />
            <div className="mx-1 h-4 w-px bg-[var(--border)]" />
            <SubjectActionButton icon={<Archive size={18} />} title="Archive" />
            <SubjectActionButton
              icon={<FlagIcon size={17} />}
              title={selectedThread?.isStarred ? 'Remove flag' : 'Flag'}
              className={selectedThread?.isStarred ? 'text-[var(--amber)]' : undefined}
              onClick={() => {
                if (selectedThread) void toggleThreadStarred(selectedThread);
              }}
            />
            <SubjectActionButton
              icon={<DeleteIcon size={17} />}
              title="Delete"
              onClick={() => {
                if (selectedThread) void deleteThread(selectedThread);
              }}
            />
            <div className="relative">
              <SubjectActionButton
                icon={<MoreIcon size={17} />}
                title="More actions"
                onClick={() => setMoreOpen((v) => !v)}
              />
              {moreOpen && (
                <div className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
                  <button
                    type="button"
                    disabled={!selectedThread}
                    onClick={() => {
                      setMoreOpen(false);
                      if (selectedThread) {
                        void markThreadRead(selectedThread, !selectedThread.isRead);
                      }
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] hover:bg-[var(--hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <MailIcon size={16} />
                    <span>{selectedThread?.isRead ? 'Mark as unread' : 'Mark as read'}</span>
                  </button>
                </div>
              )}
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
