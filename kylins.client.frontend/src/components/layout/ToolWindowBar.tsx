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
import { useContactStore } from '../../stores/contactStore';
import { useIncompleteTaskCount } from '../../stores/taskStore';
import { Button, ToggleButton, ToggleButtonGroup } from 'react-aria-components';

interface ToolWindowItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const APP_TOOLS: ToolWindowItem[] = [
  { id: 'mail', label: 'Mail', icon: <MailIcon size={22} /> },
  { id: 'calendar', label: 'Calendar', icon: <CalendarIcon size={22} /> },
  { id: 'contacts', label: 'Contacts', icon: <ContactsIcon size={22} /> },
  { id: 'tasks', label: 'Tasks', icon: <TasksIcon size={22} /> },
];

const AUX_TOOLS: ToolWindowItem[] = [
  { id: 'ai', label: 'AI Assistant', icon: <AiIcon size={22} /> },
];

const TOOL_BUTTON_CLASS =
  'relative grid place-items-center w-11 h-11 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function ToolWindowBar() {
  const activeToolWindow = useUIStore((s) => s.activeToolWindow);
  const setActiveToolWindow = useUIStore((s) => s.setActiveToolWindow);
  const activeApp = useUIStore((s) => s.activeApp);
  const setActiveApp = useUIStore((s) => s.setActiveApp);
  const folderPaneVisible = useViewStore((s) => s.folderPaneVisible);
  const setFolderPaneVisible = useViewStore((s) => s.setFolderPaneVisible);
  const accountPaneVisible = useContactStore((s) => s.accountPaneVisible);
  const toggleAccountPane = useContactStore((s) => s.toggleAccountPane);
  const incompleteTaskCount = useIncompleteTaskCount();

  const isContacts = activeApp === 'contacts';
  const leftPaneVisible = isContacts ? accountPaneVisible : folderPaneVisible;
  const leftPaneLabel = leftPaneVisible
    ? isContacts
      ? 'Hide account pane'
      : 'Hide folder pane'
    : isContacts
      ? 'Show account pane'
      : 'Show folder pane';
  const toggleLeftPane = () => {
    if (isContacts) {
      toggleAccountPane();
    } else {
      setFolderPaneVisible(!folderPaneVisible);
    }
  };

  return (
    <nav
      aria-label="Activity bar"
      className="flex w-[var(--tool-w)] shrink-0 flex-col items-center justify-between glass bg-gradient-to-r from-[var(--chrome-glass-start)] to-[var(--chrome-glass-end)] border-r border-[var(--glass-border)] py-2"
    >
      <ToggleButtonGroup
        selectionMode="single"
        selectedKeys={activeApp ? [activeApp] : []}
        onSelectionChange={(keys) => {
          const next = Array.from(keys)[0];
          if (next) {
            setActiveApp(next as typeof activeApp);
            setActiveToolWindow(null);
          }
        }}
        className="flex flex-col items-center gap-2"
      >
        {APP_TOOLS.map((tool) => (
          <ToggleButton
            key={tool.id}
            id={tool.id}
            aria-label={tool.label}
            className={({ isSelected }) =>
              `${TOOL_BUTTON_CLASS} ${
                isSelected
                  ? 'bg-selected text-primary'
                  : 'text-muted-text hover:bg-hover hover:text-foreground'
              }`
            }
          >
            {({ isSelected }) => (
              <>
                {isSelected && (
                  <span className="absolute bottom-2 left-0 top-2 w-1 rounded-r bg-primary" />
                )}
                {tool.icon}
                {tool.id === 'tasks' && incompleteTaskCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
                    {incompleteTaskCount > 99 ? '99+' : incompleteTaskCount}
                  </span>
                )}
              </>
            )}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      <div className="flex flex-col items-center gap-2">
        <ToggleButtonGroup
          selectionMode="single"
          selectedKeys={activeToolWindow ? [activeToolWindow] : []}
          onSelectionChange={(keys) => {
            const next = Array.from(keys)[0];
            setActiveToolWindow(next ? (next as typeof activeToolWindow) : null);
          }}
          className="flex flex-col items-center gap-2"
        >
          {AUX_TOOLS.map((tool) => (
            <ToggleButton
              key={tool.id}
              id={tool.id}
              aria-label={tool.label}
              className={({ isSelected }) =>
                `${TOOL_BUTTON_CLASS} ${
                  isSelected
                    ? 'bg-selected text-primary'
                    : 'text-muted-text hover:bg-hover hover:text-foreground'
                }`
              }
            >
              {({ isSelected }) => (
                <>
                  {isSelected && (
                    <span className="absolute bottom-2 left-0 top-2 w-1 rounded-r bg-primary" />
                  )}
                  {tool.icon}
                </>
              )}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Button
          aria-label={leftPaneLabel}
          onPress={toggleLeftPane}
          className={`${TOOL_BUTTON_CLASS} text-muted-text hover:bg-hover hover:text-foreground`}
        >
          {leftPaneVisible ? <PanelLeftCloseIcon size={22} /> : <PanelLeftOpenIcon size={22} />}
        </Button>
      </div>
    </nav>
  );
}
