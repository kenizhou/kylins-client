import { useState, useRef, useEffect } from 'react';
import { useClassification } from '../../features/classification/useClassification';
import { useSecurityIndicatorIcons } from '../../features/classification/useSecurityIndicatorIcons';
import { ClassificationIcon } from '../icons';
import type { ClassificationLevel } from '../../features/classification/classificationTypes';

const PRESET_COLORS = [
  '#6b7280',
  '#f59e0b',
  '#ef4444',
  '#10b981',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
];

const CLASSIFICATION_ICONS: string[] = [
  'square-lock',
  'circle-lock',
  'biometric',
  'fingerprint',
  'security',
  'certificate',
];

const SECURITY_ICONS: string[] = ['lock', 'shield', ...CLASSIFICATION_ICONS];

function IconPicker({
  value,
  onChange,
  options = CLASSIFICATION_ICONS,
}: {
  value: string | null;
  onChange: (icon: string | null) => void;
  options?: string[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--hover)]"
        title={value ? `Icon: ${value}` : 'No icon'}
      >
        {value ? (
          <ClassificationIcon icon={value} size={16} />
        ) : (
          <span className="text-xs text-[var(--muted-text)]">—</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-[188px] rounded-lg border border-[var(--border)] bg-[var(--background)] p-2 shadow-lg">
          <div className="mb-1 text-xs font-medium text-[var(--muted-text)]">Choose icon</div>
          <div className="grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className={`flex h-9 w-9 items-center justify-center rounded hover:bg-[var(--hover)] ${value === null ? 'bg-[var(--selected)]' : ''}`}
              title="No icon"
            >
              <span className="text-xs text-[var(--muted-text)]">—</span>
            </button>
            {options.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  onChange(id);
                  setOpen(false);
                }}
                className={`flex h-9 w-9 items-center justify-center rounded hover:bg-[var(--hover)] ${value === id ? 'bg-[var(--selected)]' : ''}`}
                title={id}
              >
                <ClassificationIcon icon={id} size={18} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`h-6 w-6 rounded-full border-2 ${value === c ? 'border-[var(--foreground)]' : 'border-transparent'}`}
          style={{ backgroundColor: c }}
          title={c}
        />
      ))}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-10 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0"
        title="Custom color"
      />
    </div>
  );
}

export function SecurityPreferences() {
  const { levels, setLevels, loaded } = useClassification();
  const { encryptedIcon, signedIcon, setIcons, loaded: iconsLoaded } = useSecurityIndicatorIcons();
  const [isSaving, setIsSaving] = useState(false);

  const commit = async (next: ClassificationLevel[]) => {
    setIsSaving(true);
    try {
      await setLevels(next.map((l, i) => ({ ...l, order: i })));
    } finally {
      setIsSaving(false);
    }
  };

  const updateLevel = (id: string, patch: Partial<ClassificationLevel>) => {
    const next = levels.map((l) => (l.id === id ? { ...l, ...patch } : l));
    void commit(next);
  };

  const moveLevel = (index: number, direction: -1 | 1) => {
    const next = [...levels];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const temp = next[index]!;
    next[index] = next[target]!;
    next[target] = temp;
    void commit(next);
  };

  const removeLevel = (id: string) => {
    if (levels.length <= 2) return;
    const next = levels.filter((l) => l.id !== id);
    void commit(next);
  };

  const addLevel = () => {
    const usedIcons = new Set(levels.map((l) => l.icon).filter(Boolean));
    const nextIcon = CLASSIFICATION_ICONS.find((i) => !usedIcons.has(i)) ?? 'certificate';
    const next: ClassificationLevel = {
      id: `level-${Date.now()}`,
      name: 'New Level',
      color: PRESET_COLORS[levels.length % PRESET_COLORS.length] ?? '#6b7280',
      icon: nextIcon,
      order: levels.length,
    };
    void commit([...levels, next]);
  };

  return (
    <div className="space-y-6 p-6">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">Classification Levels</h2>
          <button
            type="button"
            onClick={addLevel}
            className="rounded bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-fg)] hover:opacity-90"
          >
            Add level
          </button>
        </div>
        <p className="mb-4 text-xs text-[var(--muted-text)]">
          Drag-like reordering via the arrow buttons. The first level is the default for new emails.
          Confidential-level messages always force encryption and signing.
        </p>

        <div className="space-y-2">
          {levels.map((level, index) => (
            <div
              key={level.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3"
            >
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => moveLevel(index, -1)}
                  className="rounded p-0.5 text-[var(--muted-text)] hover:bg-[var(--hover)] disabled:opacity-30"
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  disabled={index === levels.length - 1}
                  onClick={() => moveLevel(index, 1)}
                  className="rounded p-0.5 text-[var(--muted-text)] hover:bg-[var(--hover)] disabled:opacity-30"
                  title="Move down"
                >
                  ▼
                </button>
              </div>

              <ColorPicker
                value={level.color}
                onChange={(color) => updateLevel(level.id, { color })}
              />

              <IconPicker
                value={level.icon ?? null}
                onChange={(icon) => updateLevel(level.id, { icon })}
              />

              <input
                type="text"
                value={level.name}
                onChange={(e) => updateLevel(level.id, { name: e.target.value })}
                className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
              />

              <button
                type="button"
                onClick={() => removeLevel(level.id)}
                disabled={levels.length <= 2}
                className="rounded px-2 py-1 text-xs text-[var(--destructive)] hover:bg-[var(--hover)] disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        {isSaving && <span className="text-xs text-[var(--muted-text)]">Saving…</span>}
        {!loaded && <span className="text-xs text-[var(--muted-text)]">Loading…</span>}
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted-text)]">
          Security indicator icons
        </h3>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="min-w-[5rem] text-sm text-[var(--foreground)]">Encrypted</span>
            <IconPicker
              value={encryptedIcon}
              onChange={(icon) => void setIcons({ encryptedIcon: icon ?? 'lock', signedIcon })}
              options={SECURITY_ICONS}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="min-w-[5rem] text-sm text-[var(--foreground)]">Signed</span>
            <IconPicker
              value={signedIcon}
              onChange={(icon) => void setIcons({ encryptedIcon, signedIcon: icon ?? 'shield' })}
              options={SECURITY_ICONS}
            />
          </div>
        </div>
        {!iconsLoaded && (
          <span className="mt-2 block text-xs text-[var(--muted-text)]">Loading…</span>
        )}
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted-text)]">
          Preview
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {levels.map((level) => (
            <span
              key={level.id}
              className="inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium"
              style={{
                borderColor: level.color,
                color: level.color,
                backgroundColor: `${level.color}15`,
              }}
            >
              <ClassificationIcon icon={level.icon} size={12} />
              {level.name}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
