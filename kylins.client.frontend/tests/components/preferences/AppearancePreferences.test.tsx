import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppearancePreferences } from '../../../src/components/preferences/AppearancePreferences';
import { useUIStore } from '../../../src/stores/uiStore';
import { useViewStore } from '../../../src/features/view/viewStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  useUIStore.setState({
    theme: 'system',
    contrast: 'default',
    skin: 'slate',
    fontSize: 'default',
    serifSubjects: false,
    reduceMotion: false,
  });
  useViewStore.setState({
    readingPanePosition: 'right',
    messageListDensity: 'normal',
    folderPaneVisible: true,
    commandRibbonVisible: true,
    statusBarVisible: true,
    conversationView: true,
  });
});

describe('AppearancePreferences', () => {
  it('updates font size when a different option is selected', () => {
    render(<AppearancePreferences />);
    fireEvent.click(screen.getByRole('radio', { name: /large/i }));
    expect(useUIStore.getState().fontSize).toBe('large');
  });

  it('toggles serif subjects', () => {
    render(<AppearancePreferences />);
    fireEvent.click(screen.getByLabelText(/serif subjects/i));
    expect(useUIStore.getState().serifSubjects).toBe(true);
  });

  it('toggles reduce motion', () => {
    render(<AppearancePreferences />);
    fireEvent.click(screen.getByLabelText(/reduce motion/i));
    expect(useUIStore.getState().reduceMotion).toBe(true);
  });
});
