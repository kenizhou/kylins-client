import { getSetting, setSetting } from '../settings';
import {
  type ShortcutSet,
  SHORTCUT_COMMANDS,
  getDefaultKeyMap,
} from './shortcutDefaults';

const OVERRIDES_KEY = 'shortcuts_overrides';
const ACTIVE_SET_KEY = 'shortcuts_set';

export interface OverridesMap {
  mac?: Record<string, string>;
  win?: Record<string, string>;
}

class ShortcutManager {
  private activeSet: ShortcutSet = 'win';
  private overrides: OverridesMap = {};
  private listeners: Set<() => void> = new Set();

  async hydrate(): Promise<void> {
    const [overridesRaw, activeSetRaw] = await Promise.all([
      getSetting(OVERRIDES_KEY),
      getSetting(ACTIVE_SET_KEY),
    ]);

    try {
      this.overrides = overridesRaw ? (JSON.parse(overridesRaw) as OverridesMap) : {};
    } catch {
      this.overrides = {};
    }

    this.activeSet = activeSetRaw === 'mac' || activeSetRaw === 'win' ? activeSetRaw : getPlatformSet();
    this.notify();
  }

  getActiveSet(): ShortcutSet {
    return this.activeSet;
  }

  async setActiveSet(set: ShortcutSet): Promise<void> {
    this.activeSet = set;
    await setSetting(ACTIVE_SET_KEY, set);
    this.notify();
  }

  getBinding(commandId: string): string {
    const setOverrides = this.overrides[this.activeSet];
    if (setOverrides?.[commandId]) {
      return setOverrides[commandId]!;
    }
    const defaults = getDefaultKeyMap(this.activeSet);
    return defaults[commandId] ?? '';
  }

  getResolvedKeyMap(): Record<string, string> {
    const defaults = getDefaultKeyMap(this.activeSet);
    const setOverrides = this.overrides[this.activeSet] ?? {};
    return { ...defaults, ...setOverrides };
  }

  async setBinding(commandId: string, binding: string): Promise<void> {
    if (!this.overrides[this.activeSet]) {
      this.overrides[this.activeSet] = {};
    }
    this.overrides[this.activeSet]![commandId] = binding;
    await this.persist();
    this.notify();
  }

  async resetBinding(commandId: string): Promise<void> {
    if (this.overrides[this.activeSet]) {
      delete this.overrides[this.activeSet]![commandId];
    }
    await this.persist();
    this.notify();
  }

  async resetAll(): Promise<void> {
    this.overrides[this.activeSet] = {};
    await this.persist();
    this.notify();
  }

  getOverrides(): OverridesMap {
    return JSON.parse(JSON.stringify(this.overrides)) as OverridesMap;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async persist(): Promise<void> {
    await setSetting(OVERRIDES_KEY, JSON.stringify(this.overrides));
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const shortcutManager = new ShortcutManager();

function getPlatformSet(): ShortcutSet {
  if (typeof navigator === 'undefined') return 'win';
  return navigator.platform.toLowerCase().includes('mac') ? 'mac' : 'win';
}

export { SHORTCUT_COMMANDS };
export type { ShortcutSet };
