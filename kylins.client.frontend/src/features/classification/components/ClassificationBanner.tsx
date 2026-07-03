import { ClassificationIcon } from '@/components/icons';
import { readableOn } from '../classificationStyle';
import type { ClassificationLevel } from '../classificationTypes';

export interface ClassificationBannerProps {
  level: ClassificationLevel;
  position: 'top' | 'bottom';
}

/**
 * Full-width colored banner used at the top (above subject) and bottom (below
 * the rendered body) of the reading pane and composer editor. Text/icons use a
 * readable foreground color on the level's solid background.
 */
export function ClassificationBanner({ level, position }: ClassificationBannerProps) {
  const rounded = position === 'top' ? 'rounded-t-md' : 'rounded-b-md';
  return (
    <div
      className={`flex items-center justify-center gap-2 px-3 py-1 text-xs font-bold uppercase tracking-widest ${rounded}`}
      style={{
        backgroundColor: level.color,
        color: readableOn(level.color),
      }}
      role="status"
      aria-label={`Classification: ${level.name}`}
    >
      <ClassificationIcon icon={level.icon} size={14} />
      {!level.icon && (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: readableOn(level.color) }}
        />
      )}
      {level.name}
    </div>
  );
}
