import { describe, it, expect } from 'vitest';
import { useViewStore } from '../../../src/features/view/viewStore';
import { DEFAULT_VIEW_STATE } from '../../../src/features/view/defaults';

describe('viewStore', () => {
  beforeEach(() => {
    useViewStore.setState(DEFAULT_VIEW_STATE);
  });

  it('starts with default state', () => {
    const state = useViewStore.getState();
    expect(state.readingPanePosition).toBe('right');
    expect(state.messageListDensity).toBe('normal');
    expect(state.folderPaneVisible).toBe(true);
    expect(state.visibleColumnIds).toEqual(
      expect.arrayContaining(['flag', 'from', 'subject', 'received']),
    );
  });

  it('updates reading pane position', () => {
    useViewStore.getState().setReadingPanePosition('bottom');
    expect(useViewStore.getState().readingPanePosition).toBe('bottom');
  });

  it('toggles folder pane visibility', () => {
    useViewStore.getState().setFolderPaneVisible(false);
    expect(useViewStore.getState().folderPaneVisible).toBe(false);
  });

  it('updates message list density', () => {
    useViewStore.getState().setMessageListDensity('compact');
    expect(useViewStore.getState().messageListDensity).toBe('compact');
  });

  it('updates visible columns', () => {
    useViewStore.getState().setVisibleColumnIds(['from', 'subject']);
    expect(useViewStore.getState().visibleColumnIds).toEqual(['from', 'subject']);
  });

  it('hydrates from a partial state', () => {
    useViewStore.getState().hydrate({ readingPanePosition: 'off' });
    expect(useViewStore.getState().readingPanePosition).toBe('off');
    // Unspecified keys keep defaults
    expect(useViewStore.getState().folderPaneVisible).toBe(true);
  });

  it('guards visibleColumnIds to remain an array during hydration', () => {
    useViewStore.getState().hydrate({ visibleColumnIds: undefined as unknown as string[] });
    expect(Array.isArray(useViewStore.getState().visibleColumnIds)).toBe(true);
  });

  it('resets to defaults', () => {
    useViewStore.getState().setReadingPanePosition('off');
    useViewStore.getState().setVisibleColumnIds(['from']);
    useViewStore.getState().resetToDefaults();

    expect(useViewStore.getState()).toEqual(expect.objectContaining(DEFAULT_VIEW_STATE));
  });
});
