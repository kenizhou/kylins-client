// Outlook-style calendar folder pane: per-account calendar source list with
// visibility toggles, color swatches, primary badge, and a context menu.

import { useMemo, useState } from 'react';
import { Button, Checkbox, Disclosure, DisclosurePanel } from 'react-aria-components';
import { useCalendarStore } from '@/stores/calendarStore';
import { useAccountStore } from '@/stores/accountStore';
import { PlusIcon, CalendarIcon, PencilIcon, TrashIcon, CheckIcon } from '@/components/icons';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { InputDialog, type InputField } from '@/components/ui/InputDialog';
import { Modal } from '@/components/ui/Modal';
import { InjectedComponentSet } from '@/components/plugins/InjectedComponentSet';

const PRESET_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#6b7280',
];

interface ColorDialogProps {
  isOpen: boolean;
  initialColor: string;
  onClose: () => void;
  onSelect: (color: string) => void;
}

function ColorDialog({ isOpen, initialColor, onClose, onSelect }: ColorDialogProps) {
  const [color, setColor] = useState(initialColor);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Calendar color"
      size="auto"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            onPress={onClose}
            className="h-11 rounded-md px-4 text-sm text-foreground transition-colors hover:bg-hover"
          >
            Cancel
          </Button>
          <Button
            onPress={() => onSelect(color)}
            className="h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-fg transition-colors hover:opacity-90"
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        <div className="flex flex-wrap gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-8 w-8 rounded-full border-2 transition-transform ${
                color === c ? 'border-[var(--foreground)] scale-110' : 'border-transparent'
              }`}
              style={{ backgroundColor: c }}
              aria-label={`Select color ${c}`}
            />
          ))}
        </div>
        <label className="flex items-center gap-3 text-sm text-foreground">
          <span>Custom</span>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-14 cursor-pointer rounded border border-border bg-transparent"
          />
        </label>
      </div>
    </Modal>
  );
}

interface RenameDialogProps {
  isOpen: boolean;
  initialName: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

function RenameDialog({ isOpen, initialName, onClose, onSubmit }: RenameDialogProps) {
  const fields: InputField[] = [
    {
      key: 'name',
      label: 'Calendar name',
      placeholder: 'Calendar name',
      defaultValue: initialName,
    },
  ];
  return (
    <InputDialog
      isOpen={isOpen}
      title="Rename calendar"
      fields={fields}
      submitLabel="Save"
      onClose={onClose}
      onSubmit={(values) => onSubmit((values.name ?? '').trim())}
    />
  );
}

interface NewCalendarDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

function NewCalendarDialog({ isOpen, onClose, onSubmit }: NewCalendarDialogProps) {
  const fields: InputField[] = [
    {
      key: 'name',
      label: 'Calendar name',
      placeholder: 'New calendar',
      defaultValue: '',
    },
  ];
  return (
    <InputDialog
      isOpen={isOpen}
      title="New calendar"
      fields={fields}
      submitLabel="Create"
      onClose={onClose}
      onSubmit={(values) => onSubmit((values.name ?? '').trim())}
    />
  );
}

interface ContextMenuState {
  x: number;
  y: number;
  calendar: import('@/services/db/calendars').DbCalendar;
}

export function CalendarPane() {
  const calendars = useCalendarStore((s) => s.calendars);
  const loadingCalendars = useCalendarStore((s) => s.loadingCalendars);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const toggleVisibility = useCalendarStore((s) => s.toggleCalendarVisibility);
  const createCalendar = useCalendarStore((s) => s.createCalendar);
  const updateCalendar = useCalendarStore((s) => s.updateCalendar);
  const deleteCalendar = useCalendarStore((s) => s.deleteCalendar);
  const setPrimaryCalendar = useCalendarStore((s) => s.setPrimaryCalendar);

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renameCal, setRenameCal] = useState<import('@/services/db/calendars').DbCalendar | null>(
    null,
  );
  const [colorCal, setColorCal] = useState<import('@/services/db/calendars').DbCalendar | null>(
    null,
  );
  const [showNew, setShowNew] = useState(false);

  const byAccount = useMemo(() => {
    const map = new Map<string, import('@/services/db/calendars').DbCalendar[]>();
    for (const cal of calendars) {
      const list = map.get(cal.accountId) ?? [];
      list.push(cal);
      map.set(cal.accountId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt - b.createdAt);
    }
    return map;
  }, [calendars]);

  function handleContextMenu(
    e: React.MouseEvent,
    cal: import('@/services/db/calendars').DbCalendar,
  ) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, calendar: cal });
  }

  function buildMenuItems(cal: import('@/services/db/calendars').DbCalendar): ContextMenuItem[] {
    return [
      {
        label: 'Rename',
        icon: PencilIcon,
        onSelect: () => setRenameCal(cal),
      },
      {
        label: 'Change color',
        icon: CheckIcon,
        onSelect: () => setColorCal(cal),
      },
      {
        label: 'Set as default',
        onSelect: () => setPrimaryCalendar(cal.id, cal.accountId),
        disabled: cal.isPrimary,
      },
      { separator: true },
      {
        label: 'Delete',
        icon: TrashIcon,
        danger: true,
        onSelect: () => deleteCalendar(cal.id),
      },
    ];
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
          Calendars
        </span>
        <div className="flex items-center gap-1">
          <InjectedComponentSet role="calendar:pane:header" containersRequired={false} />
          <Button
            onPress={() => setShowNew(true)}
            isDisabled={!activeAccountId}
            aria-label="New calendar"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-text transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40"
          >
            <PlusIcon size={15} />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-2">
        {loadingCalendars && calendars.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--muted-foreground)]">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Loading calendars…
          </div>
        )}

        {!loadingCalendars && calendars.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs text-[var(--muted-foreground)]">
            <CalendarIcon size={24} />
            <p>No calendars yet. Create one to get started.</p>
            <Button
              onPress={() => setShowNew(true)}
              isDisabled={!activeAccountId}
              className="mt-1 flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-fg transition-colors hover:opacity-90 disabled:opacity-40"
            >
              <PlusIcon size={13} />
              New calendar
            </Button>
          </div>
        )}

        {Array.from(byAccount.entries()).map(([accountId, cals]) => {
          const account = accounts.find((a) => a.id === accountId);
          const title =
            account?.accountLabel || account?.displayName || account?.email || accountId;
          return (
            <Disclosure key={accountId} defaultExpanded className="pb-2">
              <Button
                slot="trigger"
                className="group flex h-9 w-full items-center gap-1 px-1 text-left text-xs font-semibold uppercase tracking-wide text-[var(--foreground)] transition-colors hover:text-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-3 shrink-0 transition-transform group-data-[expanded=true]:rotate-90"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
                <span className="truncate">{title}</span>
              </Button>
              <DisclosurePanel className="space-y-0.5">
                {cals.map((cal) => (
                  <div
                    key={cal.id}
                    onContextMenu={(e) => handleContextMenu(e, cal)}
                    className="group flex items-center gap-2 rounded-md px-1 py-1.5 text-foreground hover:bg-[var(--hover)]"
                  >
                    <Checkbox
                      isSelected={cal.isVisible}
                      onChange={(selected) => toggleVisibility(cal.id, selected)}
                      className="flex min-h-6 cursor-pointer items-center gap-2"
                    >
                      {({ isSelected }) => (
                        <>
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              isSelected
                                ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                                : 'border-[var(--border)] bg-[var(--background)]'
                            }`}
                          >
                            {isSelected && <CheckIcon size={10} strokeWidth={3} />}
                          </div>
                        </>
                      )}
                    </Checkbox>

                    <div
                      className="h-4 w-4 shrink-0 rounded-full border border-[var(--border)]"
                      style={{ backgroundColor: cal.color || 'var(--primary)' }}
                    />

                    <span className="flex-1 truncate text-[13px]">
                      {cal.displayName || 'Untitled calendar'}
                    </span>

                    {cal.isPrimary && (
                      <span className="rounded bg-[var(--primary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--primary-fg)]">
                        Default
                      </span>
                    )}
                  </div>
                ))}
              </DisclosurePanel>
            </Disclosure>
          );
        })}
      </div>

      <div className="border-t border-[var(--border)] px-3 py-2">
        <InjectedComponentSet role="calendar:pane:footer" containersRequired={false} />
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.calendar)}
          onClose={() => setMenu(null)}
        />
      )}

      <NewCalendarDialog
        isOpen={showNew}
        onClose={() => setShowNew(false)}
        onSubmit={async (name) => {
          if (!activeAccountId || !name) return;
          await createCalendar({ accountId: activeAccountId, displayName: name });
          setShowNew(false);
        }}
      />

      {renameCal && (
        <RenameDialog
          isOpen
          initialName={renameCal.displayName || ''}
          onClose={() => setRenameCal(null)}
          onSubmit={async (name) => {
            if (!name) return;
            await updateCalendar(renameCal.id, { displayName: name });
            setRenameCal(null);
          }}
        />
      )}

      {colorCal && (
        <ColorDialog
          isOpen
          initialColor={colorCal.color || '#3b82f6'}
          onClose={() => setColorCal(null)}
          onSelect={async (color) => {
            await updateCalendar(colorCal.id, { color });
            setColorCal(null);
          }}
        />
      )}
    </div>
  );
}
