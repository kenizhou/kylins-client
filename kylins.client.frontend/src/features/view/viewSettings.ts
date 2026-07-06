import { getSetting, setSetting } from '../../services/settings';
import type { PanelSizeMap, ReadingPanePosition, ViewState } from './types';
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

const PANEL_SIZE_POSITIONS: ReadingPanePosition[] = ['right', 'bottom', 'off'];

export function isPanelSizeMap(value: unknown): value is PanelSizeMap {
  if (typeof value !== 'object' || value === null) return false;
  const map = value as Partial<PanelSizeMap>;

  for (const pos of PANEL_SIZE_POSITIONS) {
    const entry = map[pos];
    if (typeof entry !== 'object' || entry === null) return false;

    const keys =
      pos === 'off' ? (['folder', 'list'] as const) : (['folder', 'list', 'reader'] as const);
    let sum = 0;
    for (const key of keys) {
      const n = (entry as Record<string, unknown>)[key];
      if (typeof n !== 'number' || n < 0 || n > 100) return false;
      sum += n;
    }
    // Each position's sizes must fit within 100% so the layout never over-allocates.
    if (sum > 100.001) return false;
  }

  return true;
}

function isValidPaneSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 10 && value <= 80;
}

export function sanitizeViewState(partial: Record<string, unknown>): Partial<ViewState> {
  const sanitized: Partial<ViewState> = {};

  if (isReadingPanePosition(partial.readingPanePosition)) {
    sanitized.readingPanePosition = partial.readingPanePosition;
  }
  if (isBoolean(partial.folderPaneVisible)) {
    sanitized.folderPaneVisible = partial.folderPaneVisible;
  }
  if (isBoolean(partial.calendarPaneVisible)) {
    sanitized.calendarPaneVisible = partial.calendarPaneVisible;
  }
  if (isValidPaneSize(partial.calendarPaneSize)) {
    sanitized.calendarPaneSize = partial.calendarPaneSize;
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
  if (isPanelSizeMap(partial.panelSizes)) {
    sanitized.panelSizes = partial.panelSizes;
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
  await setSetting(
    STORAGE_KEY,
    JSON.stringify({
      readingPanePosition: state.readingPanePosition,
      folderPaneVisible: state.folderPaneVisible,
      calendarPaneVisible: state.calendarPaneVisible,
      calendarPaneSize: state.calendarPaneSize,
      commandRibbonVisible: state.commandRibbonVisible,
      statusBarVisible: state.statusBarVisible,
      conversationView: state.conversationView,
      messageListDensity: state.messageListDensity,
      visibleColumnIds: state.visibleColumnIds,
      panelSizes: state.panelSizes,
    }),
  );
}
