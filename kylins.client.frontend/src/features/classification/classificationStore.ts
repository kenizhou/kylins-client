import { create } from 'zustand';
import type { ClassificationLevel } from './classificationTypes';
import {
  getDefaultClassificationLevels,
  loadClassificationLevels,
  saveClassificationLevels,
  sanitizeClassificationLevels,
} from './classificationSettings';

interface ClassificationState {
  levels: ClassificationLevel[];
  loaded: boolean;
  load: () => Promise<void>;
  setLevels: (levels: ClassificationLevel[]) => Promise<void>;
  getLevelById: (id: string | null | undefined) => ClassificationLevel | undefined;
  getDefaultLevel: () => ClassificationLevel;
}

export const useClassificationStore = create<ClassificationState>((set, get) => ({
  levels: getDefaultClassificationLevels(),
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    const levels = await loadClassificationLevels();
    set({ levels, loaded: true });
  },

  setLevels: async (levels) => {
    const sanitized = sanitizeClassificationLevels(levels);
    set({ levels: sanitized });
    await saveClassificationLevels(sanitized);
  },

  getLevelById: (id) => {
    if (!id) return undefined;
    return get().levels.find((level) => level.id === id);
  },

  getDefaultLevel: () => {
    const { levels } = get();
    return levels[0] ?? getDefaultClassificationLevels()[0]!;
  },
}));
