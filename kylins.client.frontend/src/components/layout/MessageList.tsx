import { useViewStore, type MailMessage } from '../../features/view/viewStore';
import { COLUMN_REGISTRY } from '../../features/view/defaults';
import type { ColumnDef } from '../../features/view/types';
import { DEMO_MESSAGES, getInitials, formatMessageTime } from '../../data/demoMessages';
import { openViewerWindow } from '../../utils/viewerWindow';

type MessageState = 'unread' | 'read' | 'flagged' | 'vip';

interface MessageRowProps {
  sender: string;
  subject: string;
  time: string;
  initials: string;
  state: MessageState;
  selected?: boolean;
  density: 'compact' | 'normal' | 'comfortable';
  onClick?: () => void;
  onDoubleClick?: () => void;
}

const RIBBON_COLOR: Record<MessageState, string> = {
  unread: 'bg-[var(--primary)]',
  read: 'bg-[var(--border)]',
  flagged: 'bg-[var(--amber)]',
  vip: 'bg-[var(--green)]',
};

const DENSITY_ROW_CLASSES = {
  compact: 'min-h-[32px] py-1',
  normal: 'min-h-[40px] py-2',
  comfortable: 'min-h-[52px] py-3',
};

function MessageRow({
  sender,
  subject,
  time,
  initials,
  state,
  selected,
  density,
  onClick,
  onDoubleClick,
}: MessageRowProps) {
  const unread = state === 'unread';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={`
        flex items-stretch gap-2.5 pr-3 pl-0 cursor-pointer
        ${DENSITY_ROW_CLASSES[density]}
        ${selected ? 'bg-[var(--selected)]' : 'hover:bg-[var(--hover)]'}
      `}
    >
      <div className={`w-[var(--radius-xs)] rounded-r-[var(--radius-xs)] ${RIBBON_COLOR[state]}`} />
      <div className="w-7 h-7 rounded-full bg-[var(--border)] grid place-items-center text-[10px] font-bold text-[var(--muted-text)] shrink-0">
        {initials}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span
            className={`text-[13px] truncate ${unread ? 'font-semibold text-[var(--text)]' : 'text-[var(--muted-text)]'}`}
          >
            {sender}
          </span>
          <span className="text-[11px] font-mono text-[var(--muted-text)] shrink-0">{time}</span>
        </div>
        <span
          className={`text-[13px] truncate ${unread ? 'font-semibold text-[var(--text)]' : 'text-[var(--muted-text)]'}`}
        >
          {subject}
        </span>
      </div>
    </div>
  );
}

function MessageGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1.5 border-b border-[var(--border)] last:border-b-0">
      <div className="px-3 py-1 font-[var(--text-overline)] uppercase tracking-[0.04em] text-[var(--muted-text)]">
        {label}
      </div>
      {children}
    </div>
  );
}

const TODAY_MESSAGES = DEMO_MESSAGES.slice(0, 2);
const YESTERDAY_MESSAGES = DEMO_MESSAGES.slice(2);

export function MessageList() {
  const density = useViewStore((s) => s.messageListDensity);
  const visibleColumnIds = useViewStore((s) => s.visibleColumnIds);
  const conversationView = useViewStore((s) => s.conversationView);
  const selectedMessage = useViewStore((s) => s.selectedMessage);
  const setSelectedMessage = useViewStore((s) => s.setSelectedMessage);

  const visibleColumns = visibleColumnIds
    .map((id) => COLUMN_REGISTRY.get(id))
    .filter((c): c is ColumnDef => c != null);

  const handleSelect = (message: MailMessage) => {
    setSelectedMessage(message);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--card)]">
      {visibleColumns.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-text)]">
          {visibleColumns.map((col) => (
            <span key={col.id} className="truncate" style={{ width: col.width }}>
              {col.label}
            </span>
          ))}
        </div>
      )}

      {conversationView && (
        <div className="px-3 py-1 text-[11px] text-[var(--primary)] bg-[var(--selected)]">
          Conversation view enabled
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <MessageGroup label="Today">
          {TODAY_MESSAGES.map((message) => (
            <MessageRow
              key={message.id}
              sender={message.from.name}
              subject={message.subject}
              time={formatMessageTime(message.date)}
              initials={getInitials(message.from.name)}
              state={message.id === 'msg-1' ? 'unread' : 'vip'}
              selected={selectedMessage?.id === message.id}
              density={density}
              onClick={() => handleSelect(message)}
              onDoubleClick={() => openViewerWindow(message)}
            />
          ))}
        </MessageGroup>
        <MessageGroup label="Yesterday">
          {YESTERDAY_MESSAGES.map((message) => (
            <MessageRow
              key={message.id}
              sender={message.from.name}
              subject={message.subject}
              time={formatMessageTime(message.date)}
              initials={getInitials(message.from.name)}
              state={message.id === 'msg-4' ? 'flagged' : 'read'}
              selected={selectedMessage?.id === message.id}
              density={density}
              onClick={() => handleSelect(message)}
              onDoubleClick={() => openViewerWindow(message)}
            />
          ))}
        </MessageGroup>
      </div>
    </div>
  );
}
