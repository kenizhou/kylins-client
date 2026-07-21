import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComposerActionsRow } from '../../../../src/components/composer/window/ComposerActionsRow';

function renderRow(over: Partial<Parameters<typeof ComposerActionsRow>[0]> = {}) {
  const props = {
    canSend: true,
    sending: false,
    onSend: vi.fn(),
    onDiscard: vi.fn(),
    onSchedule: vi.fn(),
    ...over,
  };
  render(<ComposerActionsRow {...props} />);
  return props;
}

describe('ComposerActionsRow', () => {
  it('disables Send when there are no recipients', () => {
    renderRow({ canSend: false });
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });

  it('invokes the three callbacks', () => {
    const props = renderRow();
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }));
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSchedule).toHaveBeenCalledTimes(1);
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
  });

  it('shows a sending state and blocks all actions while sending', () => {
    renderRow({ sending: true });
    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /schedule/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();
  });
});
