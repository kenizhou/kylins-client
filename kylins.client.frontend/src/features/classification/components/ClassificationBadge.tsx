import { ClassificationIcon } from '@/components/icons';
import { readableOn } from '../classificationStyle';
import type { ClassificationLevel } from '../classificationTypes';

export interface ClassificationBadgeProps {
  level: ClassificationLevel;
  size?: 'xs' | 'sm' | 'md';
}

/**
 * Compact, high-contrast ALL-CAPS pill. Used in the message-list sender row and
 * the read-ribbon Status group. Foreground is auto-derived from the level color.
 */
export function ClassificationBadge({ level, size = 'sm' }: ClassificationBadgeProps) {
  const height = size === 'md' ? 'h-5' : size === 'xs' ? 'h-3.5' : 'h-4';
  const text = size === 'md' ? 'text-[11px]' : size === 'xs' ? 'text-[9px]' : 'text-[10px]';
  const padding = size === 'xs' ? 'px-1' : 'px-1.5';
  const iconSize = size === 'md' ? 12 : size === 'xs' ? 8 : 10;

  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded font-semibold uppercase tracking-wide ${height} ${padding} ${text}`}
      style={{
        backgroundColor: level.color,
        color: readableOn(level.color),
      }}
      title={level.name}
    >
      <ClassificationIcon icon={level.icon} size={iconSize} />
      {!level.icon && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: readableOn(level.color) }}
        />
      )}
      {level.name}
    </span>
  );
}
