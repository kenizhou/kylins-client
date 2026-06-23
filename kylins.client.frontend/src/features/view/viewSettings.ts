import { getSetting, setSetting } from '../../services/settings';
import type { ViewState } from './types';
import { COLUMN_REGISTRY } from './defaults';

const STORAGE_KEY = 'view.state';

function isReadingPanePosition(value: unknown): value is ViewState['readingPanePosition'] {
  return value === 'right' || value === 'bottom' || value === 'off';
}

function isMessageListDensity(value: unknown): value is ViewState['messageListDensity'] {
  return value === 'compact' || value === 'normal' || value === 'comfortable';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function sanitizeViewState(partial: Record<string, unknown>): Partial<ViewState> {
  const sanitized: Partial<ViewState> = {};

  if (isReadingPanePosition(partial.readingPanePosition)) {
    sanitized.readingPanePosition = partial.readingPanePosition;
  }
  if (isBoolean(partial.folderPaneVisible)) {
    sanitized.folderPaneVisible = partial.folderPaneVisible;
  }
  if (isBoolean(partial.commandRibbonVisible)) {
    sanitized.commandRibbonVisible = partial.commandRibbonVisible;
  }
  if (isBoolean(partial.statusBarVisible)) {
    sanitized.statusBarVisible = partial.statusBarVisible;
  }
  if (isBoolean(partial.conversationView)) {
    sanitized.conversationView = partial.conversationView;
  }
  if (isMessageListDensity(partial.messageListDensity)) {
    sanitized.messageListDensity = partial.messageListDensity;
  }
  if (isStringArray(partial.visibleColumnIds)) {
    // Drop unknown column IDs and preserve order
    sanitized.visibleColumnIds = partial.visibleColumnIds.filter((id) => COLUMN_REGISTRY.has(id));
  }

  return sanitized;
}

export async function loadViewSettings(): Promise<Partial<ViewState>> {
  try {
    const raw = await getSetting(STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return sanitizeViewState(parsed);
  } catch {
    // On parse error, fall back to defaults
    return {};
  }
}

export async function saveViewSettings(state: ViewState): Promise<void> {
  await setSetting(STORAGE_KEY, JSON.stringify(state));
}
