import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { getSetting, setSetting } = vi.hoisted(() => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../src/services/settings', () => ({ getSetting, setSetting }));

import { ClassificationSection } from '../../../src/components/preferences/ClassificationSection';
import { useClassificationStore } from '../../../src/features/classification/classificationStore';
import { getDefaultClassificationLevels } from '../../../src/features/classification/classificationSettings';

beforeEach(() => {
  getSetting.mockClear();
  setSetting.mockClear();
  useClassificationStore.setState({
    levels: getDefaultClassificationLevels(),
    loaded: true,
  });
});

describe('ClassificationSection', () => {
  it('renders the default levels with their names', () => {
    render(<ClassificationSection />);
    expect(screen.getByDisplayValue('Unclassified')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Restricted')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Confidential')).toBeInTheDocument();
  });

  it('renames a level and persists via the store', async () => {
    render(<ClassificationSection />);
    const input = screen.getByDisplayValue('Restricted');
    fireEvent.change(input, { target: { value: 'Secret' } });
    await waitFor(() =>
      expect(useClassificationStore.getState().levels.map((l) => l.name)).toContain('Secret'),
    );
    await waitFor(() => expect(setSetting).toHaveBeenCalled());
  });

  it('adds a new level with a deduped id', async () => {
    render(<ClassificationSection />);
    fireEvent.click(screen.getByRole('button', { name: /add level/i }));
    await waitFor(() => expect(useClassificationStore.getState().levels).toHaveLength(4));
    const added = useClassificationStore.getState().levels[3]!;
    expect(added.id).toBe('new-level');
    expect(screen.getByDisplayValue('New level')).toBeInTheDocument();
  });

  it('deletes a level', async () => {
    render(<ClassificationSection />);
    fireEvent.click(screen.getByRole('button', { name: /delete confidential/i }));
    await waitFor(() =>
      expect(useClassificationStore.getState().levels.map((l) => l.id)).not.toContain(
        'confidential',
      ),
    );
  });

  it('resets to defaults only after confirmation', async () => {
    useClassificationStore.setState({
      levels: [{ id: 'x', name: 'Custom', color: '#123456', icon: null, order: 0 }],
    });
    render(<ClassificationSection />);
    fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));
    // Not yet reset — waiting for confirmation.
    expect(useClassificationStore.getState().levels.map((l) => l.id)).toEqual(['x']);
    fireEvent.click(screen.getByRole('button', { name: /confirm reset/i }));
    await waitFor(() =>
      expect(useClassificationStore.getState().levels.map((l) => l.id)).toEqual([
        'unclassified',
        'restricted',
        'confidential',
      ]),
    );
  });
});
