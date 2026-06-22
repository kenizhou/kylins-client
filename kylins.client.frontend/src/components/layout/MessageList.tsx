import { PaneHeader } from './PaneHeader';

interface MessageRowProps {
  sender: string;
  subject: string;
  time: string;
  initials: string;
  state: 'unread' | 'read' | 'flagged' | 'vip';
  selected?: boolean;
}

function MessageRow({ sender, subject, time, initials, state, selected }: MessageRowProps) {
  const ribbonClass = {
    unread: 'bg-[var(--primary)]',
    read: 'bg-[var(--border)]',
    flagged: 'bg-[var(--amber)]',
    vip: 'bg-[var(--green)]',
  }[state];

  return (
    <div className={`flex items-center gap-2.5 min-h-[48px] px-3 py-2 cursor-pointer border-b border-transparent hover:bg-[var(--hover)] ${selected ? 'bg-[var(--selected-bg)]' : ''}`}>
      <div className={`w-[3px] self-stretch rounded-r-[2px] ${ribbonClass}`} />
      <div className="w-7 h-7 rounded-full bg-[var(--border)] grid place-items-center text-[10px] font-bold text-[var(--muted-text)]">{initials}</div>
      <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className={`text-sm truncate ${state === 'unread' ? 'font-semibold' : ''}`}>{sender}</span>
          <span className="text-[11px] font-mono text-[var(--muted-text)] shrink-0">{time}</span>
        </div>
        <span className="text-sm text-[var(--muted-text)] truncate">{subject}</span>
      </div>
    </div>
  );
}

export function MessageList() {
  return (
    <div className="flex flex-col h-full bg-[var(--background)]">
      <PaneHeader title="Messages" role="message-list:header" />
      <div className="flex-1 overflow-auto">
        <div className="py-1.5 border-b border-[var(--border)]">
          <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-[var(--muted-text)]">Today</div>
          <MessageRow sender="Kevin Sturgis" subject="Coral Gables project — revised timeline" time="9:30 AM" initials="KS" state="unread" selected />
          <MessageRow sender="Cecil Folk" subject="Security review passed" time="1:23 PM" initials="CF" state="vip" />
        </div>
      </div>
    </div>
  );
}
