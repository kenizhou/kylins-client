import { describe, it, expect } from 'vitest';
import { sanitizeViewState } from '../../../src/features/view/viewSettings';
import { DEFAULT_PANEL_SIZES } from '../../../src/features/view/defaults';

describe('viewSettings', () => {
  describe('sanitizeViewState', () => {
    it('keeps valid panel sizes', () => {
      const result = sanitizeViewState({ panelSizes: DEFAULT_PANEL_SIZES });
      expect(result.panelSizes).toEqual(DEFAULT_PANEL_SIZES);
    });

    it('drops panel sizes with missing keys', () => {
      const result = sanitizeViewState({
        panelSizes: {
          right: { folder: 20, list: 30 },
          bottom: {},
          off: {},
        } as unknown as typeof DEFAULT_PANEL_SIZES,
      });
      expect(result.panelSizes).toBeUndefined();
    });

    it('drops panel sizes with out-of-range values', () => {
      const result = sanitizeViewState({
        panelSizes: {
          right: { folder: 20, list: 30, reader: 50 },
          bottom: { folder: 20, list: 48, reader: 101 },
          off: { folder: 20, list: 80 },
        },
      });
      expect(result.panelSizes).toBeUndefined();
    });

    it('drops panel sizes with non-numeric values', () => {
      const result = sanitizeViewState({
        panelSizes: {
          right: { folder: '20', list: 30, reader: 50 },
          bottom: { folder: 20, list: 48, reader: 32 },
          off: { folder: 20, list: 80 },
        } as unknown as typeof DEFAULT_PANEL_SIZES,
      });
      expect(result.panelSizes).toBeUndefined();
    });

    it('keeps other valid fields alongside panel sizes', () => {
      const result = sanitizeViewState({
        readingPanePosition: 'bottom',
        panelSizes: DEFAULT_PANEL_SIZES,
      });
      expect(result.readingPanePosition).toBe('bottom');
      expect(result.panelSizes).toEqual(DEFAULT_PANEL_SIZES);
    });
  });
});
