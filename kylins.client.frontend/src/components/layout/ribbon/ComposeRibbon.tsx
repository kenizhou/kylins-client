import { useState, useRef, useEffect } from 'react';
import { SendIcon, ClockIcon, AttachmentIcon, LinkIcon, ClassificationIcon } from '../../icons';
import { ArrowBendUpRight, Lock, ShieldCheck, Warning } from '@phosphor-icons/react';
import { useComposerStore } from '../../../stores/composerStore';
import { useClassification } from '../../../features/classification/useClassification';
import { ClassificationBadge } from '../../../features/classification/components/ClassificationBadge';
import { isProminent } from '../../../features/classification/classificationStyle';
import type { ClassificationLevel } from '../../../features/classification/classificationTypes';
import { RibbonButton, RibbonGroup, RibbonToggle } from './RibbonPrimitives';
import { RibbonShell } from './RibbonShell';

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

export function ComposeRibbon() {
  const {
    classificationId,
    isEncrypted,
    isSigned,
    importance,
    requestReadReceipt,
    deliverAt,
    preventCopy,
    setClassificationId,
    setIsEncrypted,
    setIsSigned,
    setImportance,
    setRequestReadReceipt,
    setPreventCopy,
  } = useComposerStore();
  const { levels, getLevelById, getDefaultLevel } = useClassification();
  const currentLevel = getLevelById(classificationId) ?? getDefaultLevel();
  const requiresCrypto = currentLevel.id === 'confidential' || currentLevel.id === 'restricted';

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  // Prominent levels default crypto on; Unclassified defaults off.
  const handleSelect = (level: ClassificationLevel) => {
    setClassificationId(level.id);
    const crypto = level.id === 'confidential' || level.id === 'restricted';
    setIsEncrypted(crypto);
    setIsSigned(crypto);
    setPreventCopy(level.id === 'confidential');
    setOpen(false);
  };

  const scheduleActive = deliverAt != null;

  return (
    <RibbonShell>
      <RibbonGroup>
        <RibbonButton
          primary
          icon={<SendIcon size={17} />}
          onClick={() => window.dispatchEvent(new Event('composer:send-requested'))}
        >
          Send
        </RibbonButton>
        <RibbonButton
          icon={<ClockIcon size={17} />}
          split
          title={
            scheduleActive ? new Date(deliverAt).toLocaleString() : 'Schedule / Delay delivery'
          }
          className={scheduleActive ? 'text-[var(--primary)]' : undefined}
          onClick={() => window.dispatchEvent(new Event('composer:schedule-requested'))}
        >
          {scheduleActive ? 'Scheduled' : 'Delay Delivery'}
        </RibbonButton>
      </RibbonGroup>

      <RibbonGroup>
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
            </div>
          )}

          {isProminent(currentLevel) && <ClassificationBadge level={currentLevel} size="sm" />}
        </div>
      </RibbonGroup>

      <RibbonGroup>
        <RibbonToggle
          icon={<ArrowBendUpRight size={14} />}
          label="High Importance"
          title="High priority"
          checked={importance === 'high'}
          onChange={(checked) => setImportance(checked ? 'high' : 'normal')}
        />
        <RibbonToggle
          icon={<Warning size={14} />}
          label="Low Importance"
          title="Low priority"
          checked={importance === 'low'}
          onChange={(checked) => setImportance(checked ? 'low' : 'normal')}
        />
        <RibbonToggle
          icon={<AttachmentIcon size={14} />}
          label="Read Receipt"
          title="Request a read receipt"
          checked={requestReadReceipt}
          onChange={setRequestReadReceipt}
        />
      </RibbonGroup>

      <RibbonGroup>
        <RibbonToggle
          icon={<Lock size={14} />}
          label="Encrypt"
          checked={isEncrypted}
          disabled={requiresCrypto}
          onChange={setIsEncrypted}
        />
        <RibbonToggle
          icon={<ShieldCheck size={14} />}
          label="Sign"
          checked={isSigned}
          disabled={requiresCrypto}
          onChange={setIsSigned}
        />
        <RibbonToggle
          icon={<Warning size={14} />}
          label="Prevent Copy"
          title="Discourage forwarding/copying (best-effort)"
          checked={preventCopy}
          onChange={setPreventCopy}
        />
      </RibbonGroup>

      <RibbonGroup>
        <RibbonButton icon={<AttachmentIcon size={17} />}>Attach</RibbonButton>
        <RibbonButton
          icon={<LinkIcon size={17} />}
          onClick={() => window.dispatchEvent(new Event('composer:insert-link'))}
        >
          Link
        </RibbonButton>
      </RibbonGroup>
    </RibbonShell>
  );
}
