import {
  MailIcon,
  CalendarIcon,
  ContactsIcon,
  TasksIcon,
  AiIcon,
  PanelLeftOpenIcon,
  PanelLeftCloseIcon,
} from '../icons';
import { useUIStore } from '../../stores/uiStore';
import { useViewStore } from '../../features/view/viewStore';

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
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const setFolderPaneVisible = useViewStore((s) => s.setFolderPaneVisible);

  const isAppSwitcher = (id: string): id is 'mail' | 'calendar' | 'contacts' =>
    id === 'mail' || id === 'calendar' || id === 'contacts';

  return (
    <nav
      aria-label="Activity bar"
      className="flex flex-col justify-between items-center w-12 shrink-0 bg-[var(--chrome)] py-2"
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
                relative grid place-items-center w-11 h-11 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]
                ${
                  active
                    ? 'text-[var(--primary)] bg-[var(--selected)]'
                    : 'text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]'
                }
              `}
            >
              {active && (
                <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-[var(--primary)]" />
              )}
              {tool.icon}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        aria-label={folderPaneVisible ? 'Hide folder pane' : 'Show folder pane'}
        title={folderPaneVisible ? 'Hide folder pane' : 'Show folder pane'}
        onClick={() => setFolderPaneVisible(!folderPaneVisible)}
        className="grid place-items-center w-11 h-11 rounded-md text-[var(--muted-text)] hover:text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        {folderPaneVisible ? <PanelLeftCloseIcon size={22} /> : <PanelLeftOpenIcon size={22} />}
      </button>
    </nav>
  );
}
