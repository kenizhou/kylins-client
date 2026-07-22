// Classifications editor (Security tab). Lets the user rename, recolor,
// re-icon, reorder-adjacent (via add/delete), and add/remove classification
// levels. Persistence rides the existing classification store
// (`setLevels` sanitizes + writes the `classification_levels` settings key),
// so the composer banner, list pills, and viewer watermark pick changes up
// immediately.
//
// Note: the built-in ids 'restricted'/'confidential' carry behavior (they
// force Encrypt+Sign in the composer) — renaming their display name is safe,
// deleting them removes that behavior.

import { useState } from 'react';
import {
  Button,
  Checkbox,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  TextField,
} from 'react-aria-components';
import { PreferencesSectionCard } from './PreferencesSectionCard';
import { SecurityIcon, PlusIcon, TrashIcon, RestoreIcon, CheckIcon } from '../icons';
import { ClassificationIcon, CLASSIFICATION_ICON_IDS } from '../icons';
import { useClassification } from '@/features/classification/useClassification';
import { getDefaultClassificationLevels } from '@/features/classification/classificationSettings';
import type { ClassificationLevel } from '@/features/classification/classificationTypes';

const ICON_OPTIONS: { id: string; label: string }[] = [
  { id: 'none', label: 'No icon' },
  ...CLASSIFICATION_ICON_IDS.map((id) => ({ id, label: id.replace(/-/g, ' ') })),
];

/** Slugify a display name into a stable level id, deduped against existing ids. */
function makeLevelId(name: string, existing: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'level';
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

export function ClassificationSection() {
  const { levels, setLevels } = useClassification();
  const [confirmReset, setConfirmReset] = useState(false);

  const updateLevel = (id: string, patch: Partial<ClassificationLevel>) => {
    void setLevels(levels.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const deleteLevel = (id: string) => {
    // sanitizeClassificationLevels restores defaults when given an empty list,
    // so deleting the last level is safe (and effectively a reset).
    void setLevels(levels.filter((l) => l.id !== id));
  };

  const addLevel = () => {
    const name = 'New level';
    const id = makeLevelId(name, new Set(levels.map((l) => l.id)));
    void setLevels([...levels, { id, name, color: '#3b82f6', icon: 'flag', order: levels.length }]);
  };

  const resetToDefaults = () => {
    void setLevels(getDefaultClassificationLevels());
    setConfirmReset(false);
  };

  return (
    <PreferencesSectionCard title="Classifications" icon={SecurityIcon}>
      <p className="type-caption text-[var(--muted-text)]">
        Levels appear in the composer banner and on message pills. Renaming Restricted /
        Confidential keeps their auto-Encrypt+Sign behavior; deleting them removes it.
      </p>

      <div className="space-y-2">
        {levels.map((level) => (
          <div
            key={level.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2"
          >
            {/* Color swatch picker */}
            <label
              title="Level color"
              className="relative inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-[var(--border)]"
              style={{ backgroundColor: level.color }}
            >
              <input
                type="color"
                value={level.color}
                onChange={(e) => updateLevel(level.id, { color: e.target.value })}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label={`Color for ${level.name}`}
              />
            </label>

            {/* Name */}
            <TextField
              value={level.name}
              onChange={(name) => updateLevel(level.id, { name: name.trim() || level.name })}
              aria-label={`Name for ${level.name}`}
              className="min-w-0 flex-1"
            >
              <Input className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--ring)]" />
            </TextField>

            {/* Icon picker */}
            <Select
              selectedKey={level.icon ?? 'none'}
              onSelectionChange={(key) =>
                updateLevel(level.id, { icon: key === 'none' ? null : String(key) })
              }
              aria-label={`Icon for ${level.name}`}
              className="relative"
            >
              <Button className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
                <ClassificationIcon icon={level.icon} size={14} style={{ color: level.color }} />
                <SelectValue>{({ selectedText }) => <>{selectedText || 'No icon'}</>}</SelectValue>
                <span className="text-[10px] opacity-70">▼</span>
              </Button>
              <Popover className="min-w-[140px] rounded-md border border-[var(--border-subtle)] bg-[var(--surface-floating)] py-1 shadow-lg">
                <ListBox items={ICON_OPTIONS} className="outline-none" aria-label="Icon">
                  {(option) => (
                    <ListBoxItem
                      id={option.id}
                      textValue={option.label}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] outline-none data-[hovered]:bg-[var(--hover)] data-[focus-visible]:bg-[var(--hover)] data-[selected]:bg-[var(--selected)]"
                    >
                      <ClassificationIcon
                        icon={option.id === 'none' ? null : option.id}
                        size={14}
                        className="text-[var(--muted-text)]"
                      />
                      <span className="flex-1 capitalize">{option.label}</span>
                    </ListBoxItem>
                  )}
                </ListBox>
              </Popover>
            </Select>

            {/* Prominent toggle */}
            <Checkbox
              isSelected={level.prominent ?? level.order > 0}
              onChange={(prominent) => updateLevel(level.id, { prominent })}
              aria-label={`Prominent banner for ${level.name}`}
              className="group flex cursor-pointer items-center gap-1.5 text-xs text-[var(--muted-text)]"
            >
              {({ isSelected }) => (
                <>
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded border ${
                      isSelected
                        ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]'
                        : 'border-[var(--border)] bg-[var(--surface)]'
                    }`}
                  >
                    {isSelected && <CheckIcon size={10} />}
                  </span>
                  Prominent
                </>
              )}
            </Checkbox>

            {/* Delete */}
            <span title="Delete level" className="inline-flex">
              <Button
                onPress={() => deleteLevel(level.id)}
                aria-label={`Delete ${level.name}`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--destructive)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <TrashIcon size={14} />
              </Button>
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button
          onPress={addLevel}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          <PlusIcon size={14} />
          Add level
        </Button>
        {confirmReset ? (
          <>
            <span className="text-xs text-[var(--muted-text)]">Reset all levels to defaults?</span>
            <Button
              onPress={resetToDefaults}
              className="rounded-md bg-[var(--destructive)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Confirm reset
            </Button>
            <Button
              onPress={() => setConfirmReset(false)}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            onPress={() => setConfirmReset(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted-text)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <RestoreIcon size={14} />
            Reset to defaults
          </Button>
        )}
      </div>
    </PreferencesSectionCard>
  );
}
