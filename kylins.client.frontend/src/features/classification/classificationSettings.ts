import { getSetting, setSetting } from '../../services/settings';
import type { ClassificationLevel } from './classificationTypes';

const STORAGE_KEY = 'classification_levels';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function getDefaultClassificationLevels(): ClassificationLevel[] {
  return [
    { id: 'unclassified', name: 'Unclassified', color: '#6b7280', icon: null, order: 0 },
    { id: 'restricted', name: 'Restricted', color: '#f59e0b', icon: 'shield', order: 1 },
    { id: 'confidential', name: 'Confidential', color: '#ef4444', icon: 'lock', order: 2 },
  ];
}

function isValidLevel(value: unknown): value is ClassificationLevel {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.color === 'string' &&
    HEX_COLOR_RE.test(v.color) &&
    (v.icon === undefined || v.icon === null || typeof v.icon === 'string') &&
    typeof v.order === 'number' &&
    Number.isFinite(v.order) &&
    (v.prominent === undefined || typeof v.prominent === 'boolean')
  );
}

export function sanitizeClassificationLevels(value: unknown): ClassificationLevel[] {
  if (!Array.isArray(value)) return getDefaultClassificationLevels();

  const levels = value
    .filter(isValidLevel)
    .map((level) => ({
      ...level,
      icon: level.icon ?? null,
      ...(level.prominent === undefined ? {} : { prominent: level.prominent }),
    }))
    .sort((a, b) => a.order - b.order);

  // Deduplicate by id, keeping the first occurrence.
  const seen = new Set<string>();
  const deduped = levels.filter((level) => {
    if (seen.has(level.id)) return false;
    seen.add(level.id);
    return true;
  });

  if (deduped.length === 0) return getDefaultClassificationLevels();
  return deduped;
}

export async function loadClassificationLevels(): Promise<ClassificationLevel[]> {
  try {
    const raw = await getSetting(STORAGE_KEY);
    if (!raw) return getDefaultClassificationLevels();
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeClassificationLevels(parsed);
  } catch {
    return getDefaultClassificationLevels();
  }
}

export async function saveClassificationLevels(levels: ClassificationLevel[]): Promise<void> {
  await setSetting(STORAGE_KEY, JSON.stringify(levels));
}
