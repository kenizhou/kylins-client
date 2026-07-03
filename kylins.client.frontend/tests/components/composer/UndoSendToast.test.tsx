import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UndoSendToast } from '../../../src/components/composer/UndoSendToast';
import { useComposerStore } from '../../../src/stores/composerStore';

describe('UndoSendToast', () => {
  beforeEach(() => {
    useComposerStore.setState({
      undoSendVisible: false,
      undoSendTimer: null,
    });
  });

  it('renders nothing when hidden', () => {
    const { container } = render(<UndoSendToast />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the sending message and undo button', () => {
    useComposerStore.setState({ undoSendVisible: true, undoSendTimer: null });
    render(<UndoSendToast />);
    expect(screen.getByText('Sending email...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
  });

  it('hides the toast and clears the timer when undo is pressed', () => {
    useComposerStore.setState({ undoSendVisible: true, undoSendTimer: null });
    render(<UndoSendToast />);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(useComposerStore.getState().undoSendVisible).toBe(false);
    expect(useComposerStore.getState().undoSendTimer).toBeNull();
  });
});
