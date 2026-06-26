import { useEffect, useRef, useState } from 'react';
import { useComposerStore } from '@/stores/composerStore';
import { useClassification } from '@/features/classification/useClassification';
import { useSecurityIndicatorIcons } from '@/features/classification/useSecurityIndicatorIcons';
import { ClassificationIcon } from '@/components/icons';
import type { ClassificationLevel } from '@/features/classification/classificationTypes';

function ToggleRow({
  icon,
  label,
  checked,
  disabled,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-[var(--hover)]'
      }`}
      title={disabled ? 'Required for this classification' : undefined}
    >
      {icon}
      <span className="text-[var(--foreground)]">{label}</span>
      <input
        type="checkbox"
        className="ml-auto h-3.5 w-3.5 accent-[var(--primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function MenuItem({
  level,
  selected,
  onClick,
}: {
  level: ClassificationLevel;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
        selected
          ? 'bg-[var(--selected)] text-[var(--foreground)]'
          : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
      }`}
    >
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: level.color }}
      />
      <ClassificationIcon icon={level.icon} size={14} className="text-[var(--muted-text)]" />
      <span className="flex-1 whitespace-nowrap">{level.name}</span>
      {selected && <span className="text-[var(--primary)]">✓</span>}
    </button>
  );
}

export function ClassificationSelector() {
  const classificationId = useComposerStore((s) => s.classificationId);
  const isEncrypted = useComposerStore((s) => s.isEncrypted);
  const isSigned = useComposerStore((s) => s.isSigned);
  const setClassificationId = useComposerStore((s) => s.setClassificationId);
  const setIsEncrypted = useComposerStore((s) => s.setIsEncrypted);
  const setIsSigned = useComposerStore((s) => s.setIsSigned);

  const { levels, getLevelById, getDefaultLevel } = useClassification();
  const { encryptedIcon, signedIcon } = useSecurityIndicatorIcons();
  const currentLevel = getLevelById(classificationId) ?? getDefaultLevel();
  const isConfidential = currentLevel.id === 'confidential';

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isConfidential) return;
    setIsEncrypted(true);
    setIsSigned(true);
  }, [isConfidential, setIsEncrypted, setIsSigned]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleSelect = (level: ClassificationLevel) => {
    setClassificationId(level.id);
    if (level.id === 'confidential') {
      setIsEncrypted(true);
      setIsSigned(true);
    } else if (level.id === 'restricted') {
      setIsEncrypted(true);
      setIsSigned(true);
    } else {
      setIsEncrypted(false);
      setIsSigned(false);
    }
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium transition-colors hover:opacity-90"
        style={{
          borderColor: currentLevel.color,
          color: currentLevel.color,
          backgroundColor: `${currentLevel.color}15`,
        }}
        title="Classification"
      >
        <ClassificationIcon icon={currentLevel.icon} size={13} />
        <span className="whitespace-nowrap">{currentLevel.name}</span>
        <span className="text-[10px] opacity-70">▼</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
          {levels.map((level) => (
            <MenuItem
              key={level.id}
              level={level}
              selected={level.id === currentLevel.id}
              onClick={() => handleSelect(level)}
            />
          ))}
          <div className="my-1 border-t border-[var(--border)]" />
          <div className="px-2 py-1">
            <ToggleRow
              icon={
                <ClassificationIcon
                  icon={encryptedIcon}
                  size={14}
                  className="text-[var(--muted-text)]"
                />
              }
              label="Encrypt"
              checked={isEncrypted}
              disabled={isConfidential}
              onChange={setIsEncrypted}
            />
            <ToggleRow
              icon={
                <ClassificationIcon
                  icon={signedIcon}
                  size={14}
                  className="text-[var(--muted-text)]"
                />
              }
              label="Sign"
              checked={isSigned}
              disabled={isConfidential}
              onChange={setIsSigned}
            />
          </div>
        </div>
      )}
    </div>
  );
}
