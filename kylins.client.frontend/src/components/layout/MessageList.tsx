import { PaneHeader } from './PaneHeader';

type MessageState = 'unread' | 'read' | 'flagged' | 'vip';

interface MessageRowProps {
  sender: string;
  subject: string;
  time: string;
  initials: string;
  state: MessageState;
  selected?: boolean;
}

const RIBBON_COLOR: Record<MessageState, string> = {
  unread: 'bg-[var(--primary)]',
  read: 'bg-[var(--border)]',
  flagged: 'bg-[var(--amber)]',
  vip: 'bg-[var(--green)]',
};

function MessageRow({ sender, subject, time, initials, state, selected }: MessageRowProps) {
  const unread = state === 'unread';
  return (
    <div
      className={`
        flex items-stretch gap-2.5 min-h-[40px] py-2 pr-3 pl-0 cursor-pointer
        ${selected ? 'bg-[var(--selected)]' : 'hover:bg-[var(--hover)]'}
      `}
    >
      <div className={`w-[3px] rounded-r-[2px] ${RIBBON_COLOR[state]}`} />
      <div className="w-7 h-7 rounded-full bg-[var(--border)] grid place-items-center text-[10px] font-bold text-[var(--muted-text)] shrink-0">
        {initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className={`text-[13px] truncate ${unread ? 'font-semibold text-[var(--text)]' : 'text-[var(--muted-text)]'}`}>
            {sender}
          </span>
          <span className="text-[11px] font-mono text-[var(--muted-text)] shrink-0">{time}</span>
        </div>
        <span className={`text-[13px] truncate ${unread ? 'font-semibold text-[var(--text)]' : 'text-[var(--muted-text)]'}`}>
          {subject}
        </span>
      </div>
    </div>
  );
}

function Tabs() {
  return (
    <div className="flex gap-1 p-1">
      <button className="h-6 px-2.5 rounded text-[12px] font-medium bg-[var(--selected)] text-[var(--primary)]">
        Focused
      </button>
      <button className="h-6 px-2.5 rounded text-[12px] font-medium text-[var(--muted-text)] hover:bg-[var(--hover)]">
        Other
      </button>
    </div>
  );
}

function MessageGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1.5 border-b border-[var(--border)] last:border-b-0">
      <div className="px-3 py-1 text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--muted-text)]">
        {label}
      </div>
      {children}
    </div>
  );
}

export function MessageList() {
  return (
    <div className="flex flex-col h-full bg-[var(--background)]">
      <div className="h-8 flex items-center px-2 border-b bg-[var(--surface)] border-[var(--border)]">
        <Tabs />
      </div>
      <div className="flex-1 overflow-auto">
        <MessageGroup label="Today">
          <MessageRow
            sender="Kevin Sturgis"
            subject="Coral Gables project — revised timeline"
            time="9:30 AM"
            initials="KS"
            state="unread"
            selected
          />
          <MessageRow
            sender="Cecil Folk"
            subject="Security review passed"
            time="1:23 PM"
            initials="CF"
            state="vip"
          />
        </MessageGroup>
        <MessageGroup label="Yesterday">
          <MessageRow
            sender="Lydia Bauer"
            subject="Follow-up: Q3 budget draft"
            time="12:55 PM"
            initials="LB"
            state="flagged"
          />
          <MessageRow
            sender="Design Review"
            subject="Notes from yesterday's session"
            time="11:20 AM"
            initials="DR"
            state="read"
          />
          <MessageRow
            sender="Mina Nichols"
            subject="Lunch next week?"
            time="9:04 AM"
            initials="MN"
            state="read"
          />
        </MessageGroup>
      </div>
    </div>
  );
}
