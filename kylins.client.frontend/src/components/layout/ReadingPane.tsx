import { InjectedComponentSet } from '../plugins/InjectedComponentSet';
import { SmileIcon, ReplyIcon, ReplyAllIcon, ForwardIcon, MoreIcon } from '../icons';

function ShortcutButton({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <button
      className="grid place-items-center w-7 h-7 rounded text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
      title={title}
      aria-label={title}
    >
      {icon}
    </button>
  );
}

export function ReadingPane() {
  return (
    <div className="flex flex-col h-full bg-[var(--background)] min-w-0">
      <div className="px-5 pt-4 pb-3 border-b border-[var(--border)]">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h1 className="flex-1 min-w-0 font-serif text-[22px] font-semibold leading-[1.25] text-[var(--text)]">
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
        <div className="flex items-center gap-3 text-[13px] text-[var(--muted-text)]">
          <div className="w-8 h-8 rounded-full bg-[var(--border)] grid place-items-center text-[12px] font-bold text-[var(--muted-text)] shrink-0">
            KS
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-[var(--text)]">
              Kevin Sturgis &lt;kevin@example.com&gt;
            </div>
            <div>To: you · Today, 9:30 AM</div>
          </div>
        </div>
      </div>
      <div className="flex gap-1 px-5 py-2 border-b border-[var(--border)]">
        <button className="h-7 px-3 rounded text-[13px] text-[var(--text)] hover:bg-[var(--hover)]">Reply</button>
        <button className="h-7 px-3 rounded text-[13px] text-[var(--text)] hover:bg-[var(--hover)]">Forward</button>
        <button className="h-7 px-3 rounded text-[13px] text-[var(--text)] hover:bg-[var(--hover)]">Archive</button>
        <button className="h-7 px-3 rounded text-[13px] text-[var(--destructive)] hover:bg-[var(--hover)]">Delete</button>
      </div>
      <main className="flex-1 overflow-auto p-5 leading-[1.6] text-[var(--text)]">
        <p className="mb-4">Hi,</p>
        <p className="mb-4">
          After yesterday's standup I moved the foundation milestone out by two weeks. The structural drawings should be ready by Friday, but we need sign-off from the city before we can pour.
        </p>
        <p className="mb-4">
          I've attached the updated Gantt chart. Let me know if the new dates work on your end.
        </p>
        <p>— Kevin</p>
      </main>
      <InjectedComponentSet role="reading-pane:footer" containersRequired={false} />
    </div>
  );
}
