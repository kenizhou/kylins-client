import {
  MailIcon,
  CalendarIcon,
  ContactsIcon,
  TasksIcon,
  AiIcon,
  SettingsIcon,
  UserIcon,
} from '../icons';
import { useUIStore } from '../../stores/uiStore';

interface ToolWindowItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const TOOLS: ToolWindowItem[] = [
  { id: 'mail', label: 'Mail', icon: <MailIcon size={22} /> },
  { id: 'calendar', label: 'Calendar', icon: <CalendarIcon size={22} /> },
  { id: 'contacts', label: 'Contacts', icon: <ContactsIcon size={22} /> },
  { id: 'tasks', label: 'Tasks', icon: <TasksIcon size={22} /> },
  { id: 'ai', label: 'AI Assistant', icon: <AiIcon size={22} /> },
];

export function ToolWindowBar() {
  const activeToolWindow = useUIStore((s) => s.activeToolWindow);
  const setActiveToolWindow = useUIStore((s) => s.setActiveToolWindow);
  const activeApp = useUIStore((s) => s.activeApp);
  const setActiveApp = useUIStore((s) => s.setActiveApp);

  const isAppSwitcher = (id: string): id is 'mail' | 'calendar' =>
    id === 'mail' || id === 'calendar';

  return (
    <nav
      aria-label="Activity bar"
      className="flex flex-col justify-between items-center w-12 shrink-0 bg-[var(--surface)] border-r border-[var(--border)] py-2"
    >
      <div className="flex flex-col items-center gap-2">
        {TOOLS.map((tool) => {
          const active = isAppSwitcher(tool.id)
            ? activeApp === tool.id
            : activeToolWindow === tool.id;
          return (
            <button
              key={tool.id}
              aria-label={tool.label}
              title={tool.label}
              onClick={() => {
                if (isAppSwitcher(tool.id)) {
                  setActiveApp(tool.id);
                  setActiveToolWindow(null);
                } else {
                  setActiveToolWindow(active ? null : tool.id);
                }
              }}
              className={`
                relative grid place-items-center w-10 h-10 rounded-md transition-colors
                ${
                  active
                    ? 'text-[var(--primary)] bg-[var(--selected)]'
                    : 'text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]'
                }
              `}
            >
              {active && (
                <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-[var(--primary)]" />
              )}
              {tool.icon}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          className="grid place-items-center w-10 h-10 rounded-md text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
        >
          <SettingsIcon size={20} />
        </button>
        <button
          type="button"
          aria-label="Account"
          title="Account"
          className="grid place-items-center w-10 h-10 rounded-md text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors"
        >
          <UserIcon size={20} />
        </button>
      </div>
    </nav>
  );
}
