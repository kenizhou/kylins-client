import { PaneHeader } from './PaneHeader';
import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { SmileIcon, ReplyIcon, ReplyAllIcon, ForwardIcon, MoreIcon } from '../icons';

function ShortcutButton({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <button
      className="flex flex-col items-center justify-center w-11 h-11 rounded hover:bg-[var(--hover)] text-[var(--muted-text)] hover:text-[var(--text)]"
      title={title}
      aria-label={title}
    >
      {icon}
      <span className="text-[9px] mt-0.5">{title}</span>
    </button>
  );
}

export function ReadingPane() {
  return (
    <div className="flex flex-col h-full bg-[var(--background)]">
      <PaneHeader title="Reading" role="reading-pane:toolbar" />
      <div className="flex-1 overflow-auto">
        <div className="px-5 pt-4 pb-3 border-b border-[var(--border)]">
          <div className="flex items-start justify-between gap-3 mb-3">
            <h1 className="flex-1 min-w-0 font-serif text-[22px] font-semibold leading-tight text-[var(--text)]">
              Coral Gables project — revised timeline
            </h1>
            <div className="flex items-center gap-0.5 shrink-0 mt-0.5">
              <ShortcutButton icon={<SmileIcon />} title="React" />
              <ShortcutButton icon={<ReplyIcon />} title="Reply" />
              <ShortcutButton icon={<ReplyAllIcon />} title="Reply all" />
              <ShortcutButton icon={<ForwardIcon />} title="Forward" />
              <ShortcutButton icon={<MoreIcon />} title="More" />
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm text-[var(--muted-text)]">
            <div className="w-8 h-8 rounded-full bg-[var(--border)] grid place-items-center text-xs font-bold text-[var(--muted-text)]">KS</div>
            <div>
              <div className="font-semibold text-[var(--text)]">Kevin Sturgis &lt;kevin@example.com&gt;</div>
              <div>To: you · Today, 9:30 AM</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 px-5 py-2 border-b border-[var(--border)]">
          <button className="px-3 h-7 text-sm rounded hover:bg-[var(--hover)] text-[var(--text)]">Reply</button>
          <button className="px-3 h-7 text-sm rounded hover:bg-[var(--hover)] text-[var(--text)]">Forward</button>
          <button className="px-3 h-7 text-sm rounded hover:bg-[var(--hover)] text-[var(--text)]">Archive</button>
          <button className="px-3 h-7 text-sm rounded hover:bg-[var(--hover)] text-[var(--destructive)]">Delete</button>
        </div>
        <main className="flex-1 p-5 leading-relaxed text-[var(--text)]">
          <p>Hi,</p>
          <p>After yesterday's standup I moved the foundation milestone out by two weeks...</p>
        </main>
      </div>
      <InjectedComponentSet role="reading-pane:footer" containersRequired={false} />
    </div>
  );
}
