import { type ReactNode } from 'react';
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
import { useViewStore, type MailMessage } from '../../features/view/viewStore';
import { useComposerStore } from '../../stores/composerStore';
import { EmailRenderer } from '../email/EmailRenderer';
import { formatMessageDate } from '../../data/demoMessages';

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

function quotedBodyHtml(message: MailMessage | null): string {
  if (!message) return '';
  const original = message.html ?? `<pre>${escapeHtml(message.text ?? '')}</pre>`;
  return `
    <p>&nbsp;</p>
    <blockquote style="margin:0 0 0 8px;padding-left:12px;border-left:3px solid var(--border);color:var(--muted-text);">
      <p>On ${formatMessageDate(message.date)}, ${escapeHtml(message.from.name)} &lt;${escapeHtml(message.from.address)}&gt; wrote:</p>
      ${original}
    </blockquote>
  `;
}

function forwardedBodyHtml(message: MailMessage | null): string {
  if (!message) return '';
  const original = message.html ?? `<pre>${escapeHtml(message.text ?? '')}</pre>`;
  const toList = message.to
    .map((t) => `${escapeHtml(t.name)} &lt;${escapeHtml(t.address)}&gt;`)
    .join(', ');
  return `
    <p>&nbsp;</p>
    <p>---------- Forwarded message ----------</p>
    <p><strong>From:</strong> ${escapeHtml(message.from.name)} &lt;${escapeHtml(message.from.address)}&gt;</p>
    <p><strong>To:</strong> ${toList}</p>
    <p><strong>Subject:</strong> ${escapeHtml(message.subject)}</p>
    <p><strong>Date:</strong> ${formatMessageDate(message.date)}</p>
    <br/>
    ${original}
  `;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function recipientList(recipients: { name: string; address: string }[]): string {
  if (recipients.length === 0) return '';
  const first = recipients[0];
  if (!first) return '';
  if (recipients.length === 1) return `${first.name} <${first.address}>`;
  return `${first.name} <${first.address}> +${recipients.length - 1} more`;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
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
  const openComposer = useComposerStore((s) => s.openComposer);

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

  const handleReply = () => {
    openComposer({
      mode: 'reply',
      to: [message.from.address],
      subject: `Re: ${message.subject}`,
      bodyHtml: quotedBodyHtml(message),
      threadId: message.threadId ?? null,
      inReplyToMessageId: message.messageId ?? null,
    });
  };

  const handleReplyAll = () => {
    const to = [
      message.from.address,
      ...message.to.filter((t) => t.address !== 'you@kylins.local').map((t) => t.address),
    ];
    openComposer({
      mode: 'replyAll',
      to,
      subject: `Re: ${message.subject}`,
      bodyHtml: quotedBodyHtml(message),
      threadId: message.threadId ?? null,
      inReplyToMessageId: message.messageId ?? null,
    });
  };

  const handleForward = () => {
    openComposer({
      mode: 'forward',
      subject: `Fwd: ${message.subject}`,
      bodyHtml: forwardedBodyHtml(message),
      threadId: message.threadId ?? null,
    });
  };

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
              {formatMessageDate(message.date)}
            </div>
          </div>
        </div>
      </div>

      <main className="flex-1 overflow-auto p-5 leading-[1.6] text-[var(--text)]">
        <EmailRenderer
          html={message.html}
          text={message.text}
          blockImages
          senderAddress={message.from.address}
          accountId={null}
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
