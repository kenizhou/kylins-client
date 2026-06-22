import { MailIcon, CalendarIcon, ContactsIcon, TasksIcon, AiIcon } from '../icons';
import { useUIStore } from '../../stores/uiStore';

interface ToolWindowItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const TOOLS: ToolWindowItem[] = [
  { id: 'mail', label: 'Mail', icon: <MailIcon size={20} /> },
  { id: 'calendar', label: 'Calendar', icon: <CalendarIcon size={20} /> },
  { id: 'contacts', label: 'Contacts', icon: <ContactsIcon size={20} /> },
  { id: 'tasks', label: 'Tasks', icon: <TasksIcon size={20} /> },
  { id: 'ai', label: 'AI Assistant', icon: <AiIcon size={20} /> },
];

export function ToolWindowBar() {
  const activeToolWindow = useUIStore((s) => s.activeToolWindow);
  const setActiveToolWindow = useUIStore((s) => s.setActiveToolWindow);

  return (
    <nav
      aria-label="Tool windows"
      className="flex flex-col items-center gap-1 pt-2 w-11 shrink-0 bg-[var(--surface)] border-r border-[var(--border)]"
    >
      {TOOLS.map((tool) => {
        const active = activeToolWindow === tool.id;
        return (
          <button
            key={tool.id}
            aria-label={tool.label}
            title={tool.label}
            onClick={() => setActiveToolWindow(active ? null : tool.id)}
            className={`
              relative grid place-items-center w-9 h-9 rounded-md transition-colors
              ${active
                ? 'text-[var(--primary)] bg-[var(--selected)]'
                : 'text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--text)]'}
              before:absolute before:left-[-5px] before:top-[10px] before:bottom-[10px] before:w-[3px] before:rounded-r-sm
              ${active ? 'before:bg-[var(--primary)]' : 'before:bg-transparent'}
            `}
          >
            {tool.icon}
          </button>
        );
      })}
    </nav>
  );
}
