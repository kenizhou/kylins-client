import { Select, SelectValue, Button, Popover, ListBox, ListBoxItem } from 'react-aria-components';
import { useActiveComposerTarget } from './useActiveComposerTarget';
import { useClassification } from '@/features/classification/useClassification';
import { ClassificationIcon } from '@/components/icons';
import type { ClassificationLevel } from '@/features/classification/classificationTypes';

/**
 * Classification level picker (slim full-width banner). Binds to whichever
 * composer surface is live — the docked inline composer when visible, else
 * the compose-window composerStore — via useActiveComposerTarget, so the same
 * component works in both the OS compose window and the inline dock.
 */
export function ClassificationSelector() {
  const { classificationId, setClassificationId, setIsEncrypted, setIsSigned } =
    useActiveComposerTarget();

  const { levels, getLevelById, getDefaultLevel } = useClassification();
  const currentLevel = getLevelById(classificationId) ?? getDefaultLevel();

  const handleSelect = (level: ClassificationLevel) => {
    setClassificationId(level.id);
    if (level.id === 'confidential' || level.id === 'restricted') {
      setIsEncrypted(true);
      setIsSigned(true);
    } else {
      setIsEncrypted(false);
      setIsSigned(false);
    }
  };

  return (
    <Select
      aria-label="Classification"
      selectedKey={currentLevel.id}
      onSelectionChange={(key) => {
        const level = levels.find((l) => l.id === key);
        if (level) handleSelect(level);
      }}
      className="relative flex w-full items-center"
    >
      {/* Slim full-width banner: doubles as the classification indicator for
          the whole header area and as the level picker trigger. */}
      <Button
        className="flex h-7 w-full items-center gap-1.5 px-3 text-xs font-medium transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{
          color: currentLevel.color,
          backgroundColor: `${currentLevel.color}12`,
        }}
        aria-label={`Classification: ${currentLevel.name}`}
      >
        <ClassificationIcon icon={currentLevel.icon} size={13} />
        <SelectValue>
          {() => <span className="whitespace-nowrap">{currentLevel.name}</span>}
        </SelectValue>
        <span className="ml-auto text-[10px] opacity-70">▼</span>
      </Button>
      <Popover className="min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg">
        <ListBox items={levels} className="outline-none" aria-label="Classification">
          {(level) => (
            <ListBoxItem
              id={level.id}
              textValue={level.name}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] data-[selected]:bg-[var(--selected)] data-[selected]:text-[var(--foreground)]"
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: level.color }}
              />
              <ClassificationIcon
                icon={level.icon}
                size={14}
                className="text-[var(--muted-text)]"
              />
              <span className="flex-1 whitespace-nowrap">{level.name}</span>
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}
