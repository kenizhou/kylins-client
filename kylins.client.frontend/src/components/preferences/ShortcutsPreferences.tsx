import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SearchField, Input, Button } from 'react-aria-components';
import { useShortcutStore } from '../../stores/shortcutStore';
import type { ShortcutSet } from '../../services/shortcuts/shortcutDefaults';
import {
  captureBinding,
  formatBindingForDisplay,
  parseBinding,
  stringifyCombo,
} from '../../services/shortcuts/shortcutEngine';
import {
  getCategories,
  getCommandsByCategory,
  getCommandById,
  SHORTCUT_COMMANDS,
} from '../../services/shortcuts/shortcutDefaults';
import { shortcutManager } from '../../services/shortcuts/shortcutManager';
import { isMac } from '../../utils/platform';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { SegmentedControl } from '../ui/SegmentedControl';
import { PreferencesShortcutsIcon, CloseIcon } from '../icons';

const SET_OPTIONS: { value: ShortcutSet; label: string }[] = [
  { value: 'mac', label: 'macOS' },
  { value: 'win', label: 'Windows / Linux' },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.75rem] px-1.5 h-6 rounded border border-[var(--border)] bg-[var(--background)] text-xs font-medium text-[var(--foreground)] shadow-sm">
      {children}
    </kbd>
  );
}

function findConflict(
  commandId: string,
  binding: string,
  keyMap: Record<string, string>,
): string | null {
  for (const [id, existing] of Object.entries(keyMap)) {
    if (id === commandId) continue;
    if (normalizeBinding(existing) === normalizeBinding(binding)) {
      return id;
    }
  }
  return null;
}

function normalizeBinding(binding: string): string {
  const parsed = parseBinding(binding);
  return parsed.combos.map(stringifyCombo).join(' ');
}

function ShortcutRow({
  commandId,
  binding,
  isRecording,
  onStartRecording,
  onReset,
  conflictId,
}: {
  commandId: string;
  binding: string;
  isRecording: boolean;
  onStartRecording: (id: string) => void;
  onReset: (id: string) => void;
  conflictId: string | null;
}) {
  const command = getCommandById(commandId);
  const mac = isMac();
  const isDefault = binding === shortcutManager.getBinding(commandId);

  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-[var(--border)] last:border-b-0">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm text-[var(--foreground)] truncate">
          {command?.label ?? commandId}
        </span>
        {conflictId && (
          <span className="text-[11px] text-[var(--destructive)]">
            Conflicts with {getCommandById(conflictId)?.label ?? conflictId}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {isRecording ? (
          <Button
            onPress={() => onStartRecording('')}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--primary)] text-[var(--primary-fg)] animate-pulse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            Press keys…
          </Button>
        ) : (
          <Button
            onPress={() => onStartRecording(commandId)}
            className="flex items-center gap-2 px-2 py-1 rounded-md border border-[var(--border)] bg-[var(--background)] hover:bg-[var(--hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label={`Change shortcut for ${command?.label ?? commandId}`}
          >
            <Kbd>{formatBindingForDisplay(binding || '—', mac)}</Kbd>
          </Button>
        )}

        {!isDefault && !isRecording && (
          <Button
            onPress={() => onReset(commandId)}
            className="p-1 rounded text-[var(--muted-text)] hover:text-[var(--destructive)] hover:bg-[color-mix(in_oklab,var(--destructive),transparent_90%)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label="Reset to default"
          >
            <CloseIcon size={12} />
          </Button>
        )}
      </div>
    </div>
  );
}

export function ShortcutsPreferences() {
  const activeSet = useShortcutStore((s) => s.activeSet);
  const keyMap = useShortcutStore((s) => s.keyMap);
  const setActiveSet = useShortcutStore((s) => s.setActiveSet);
  const setBinding = useShortcutStore((s) => s.setBinding);
  const resetBinding = useShortcutStore((s) => s.resetBinding);
  const resetAll = useShortcutStore((s) => s.resetAll);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const recordingIdRef = useRef(recordingId);
  useEffect(() => {
    recordingIdRef.current = recordingId;
  }, [recordingId]);

  const hasCustomizations = useMemo(() => {
    const overrides = shortcutManager.getOverrides()[activeSet];
    return overrides ? Object.keys(overrides).length > 0 : false;
  }, [activeSet]);

  useEffect(() => {
    if (!recordingId) return;

    function handleCapture(event: KeyboardEvent) {
      event.stopImmediatePropagation();
      event.preventDefault();

      if (event.key === 'Escape') {
        setRecordingId(null);
        return;
      }

      if (event.key === 'Backspace') {
        // Clear the binding entirely.
        void setBinding(recordingIdRef.current!, '');
        setRecordingId(null);
        return;
      }

      const captured = captureBinding(event, isMac());
      if (captured) {
        void setBinding(recordingIdRef.current!, captured);
        setRecordingId(null);
      }
    }

    window.addEventListener('keydown', handleCapture, true);
    return () => window.removeEventListener('keydown', handleCapture, true);
  }, [recordingId, setBinding]);

  const handleSetActiveSet = useCallback(
    async (value: ShortcutSet) => {
      await setActiveSet(value);
    },
    [setActiveSet],
  );

  const filteredCategories = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return getCategories();
    const cats = new Set<string>();
    for (const cmd of SHORTCUT_COMMANDS) {
      if (
        cmd.label.toLowerCase().includes(term) ||
        cmd.id.toLowerCase().includes(term) ||
        cmd.category.toLowerCase().includes(term)
      ) {
        cats.add(cmd.category);
      }
    }
    return Array.from(cats);
  }, [search]);

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 gap-5">
        <PreferencesSectionCard title="Shortcut set" icon={PreferencesShortcutsIcon}>
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-[var(--foreground)]">
                  Active platform set
                </span>
                <span className="text-xs text-[var(--muted-text)]">
                  Defaults and display labels switch to match the selected platform.
                </span>
              </div>
              <SegmentedControl
                options={SET_OPTIONS}
                value={activeSet}
                onChange={handleSetActiveSet}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <SearchField
                value={search}
                onChange={setSearch}
                className="relative flex-1"
                aria-label="Search shortcuts"
              >
                <Input
                  type="text"
                  placeholder="Search shortcuts…"
                  className="flex-1 h-9 px-3 pr-8 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)] outline-none"
                />
                {search !== '' && (
                  <Button className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded p-0.5 text-[var(--muted-text)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
                    <CloseIcon size={14} />
                  </Button>
                )}
              </SearchField>
              {hasCustomizations && (
                <Button
                  onPress={() => void resetAll()}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  Reset all
                </Button>
              )}
            </div>
          </div>
        </PreferencesSectionCard>

        {filteredCategories.map((category) => {
          const commands = getCommandsByCategory(category).filter((cmd) => {
            const term = search.trim().toLowerCase();
            if (!term) return true;
            return cmd.label.toLowerCase().includes(term) || cmd.id.toLowerCase().includes(term);
          });
          if (commands.length === 0) return null;
          return (
            <PreferencesSectionCard key={category} title={category} icon={PreferencesShortcutsIcon}>
              {commands.map((cmd) => {
                const binding = keyMap[cmd.id] ?? '';
                const conflict = findConflict(cmd.id, binding, keyMap);
                return (
                  <ShortcutRow
                    key={cmd.id}
                    commandId={cmd.id}
                    binding={binding}
                    isRecording={recordingId === cmd.id}
                    onStartRecording={setRecordingId}
                    onReset={(id) => void resetBinding(id)}
                    conflictId={conflict}
                  />
                );
              })}
            </PreferencesSectionCard>
          );
        })}
      </div>
    </div>
  );
}
