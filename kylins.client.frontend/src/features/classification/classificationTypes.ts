export interface ClassificationLevel {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
  order: number;
  /**
   * When true, this level gets high-visibility treatment everywhere (row tint +
   * ALL-CAPS pill in the list, full-width banners + watermark in the viewer and
   * composer). When omitted, prominence falls back to `order > 0` (see
   * `isProminent` in `classificationStyle.ts`), so the default Restricted /
   * Confidential levels are prominent and Unclassified is not.
   */
  prominent?: boolean;
}
