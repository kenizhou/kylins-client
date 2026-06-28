import { describe, it, expect } from 'vitest';
import {
  parseBinding,
  eventMatchesCombo,
  eventMatchesBinding,
  captureBinding,
  formatBindingForDisplay,
  isInputElement,
  bindingNeedsInputGuard,
} from '../../../src/services/shortcuts/shortcutEngine';

function makeEvent(init: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    bubbles: true,
  });
}

describe('shortcutEngine', () => {
  describe('parseBinding', () => {
    it('parses a simple key', () => {
      const parsed = parseBinding('j');
      expect(parsed.combos).toHaveLength(1);
      expect(parsed.combos[0]).toEqual({
        mod: false,
        ctrl: false,
        alt: false,
        shift: false,
        key: 'j',
      });
    });

    it('parses modifier combos', () => {
      const parsed = parseBinding('mod+shift+z');
      expect(parsed.combos[0]).toEqual({
        mod: true,
        ctrl: false,
        alt: false,
        shift: true,
        key: 'z',
      });
    });

    it('parses two-key sequences', () => {
      const parsed = parseBinding('g i');
      expect(parsed.combos).toHaveLength(2);
      expect(parsed.combos[0]!.key).toBe('g');
      expect(parsed.combos[1]!.key).toBe('i');
    });
  });

  describe('eventMatchesCombo', () => {
    it('matches mod+z on mac with meta+z', () => {
      const combo = parseBinding('mod+z').combos[0]!;
      expect(eventMatchesCombo(makeEvent({ key: 'z', metaKey: true }), combo, true)).toBe(true);
    });

    it('matches mod+z on windows with ctrl+z', () => {
      const combo = parseBinding('mod+z').combos[0]!;
      expect(eventMatchesCombo(makeEvent({ key: 'z', ctrlKey: true }), combo, false)).toBe(true);
    });

    it('does not match mod+z when extra modifiers are held', () => {
      const combo = parseBinding('mod+z').combos[0]!;
      expect(
        eventMatchesCombo(makeEvent({ key: 'z', ctrlKey: true, shiftKey: true }), combo, false),
      ).toBe(false);
    });

    it('matches explicit ctrl combos on mac', () => {
      const combo = parseBinding('ctrl+f').combos[0]!;
      expect(eventMatchesCombo(makeEvent({ key: 'f', ctrlKey: true }), combo, true)).toBe(true);
    });

    it('matches function keys', () => {
      const combo = parseBinding('f5').combos[0]!;
      expect(eventMatchesCombo(makeEvent({ key: 'F5' }), combo, false)).toBe(true);
    });
  });

  describe('eventMatchesBinding', () => {
    it('matches single combo', () => {
      expect(eventMatchesBinding(makeEvent({ key: 'n', ctrlKey: true }), 'mod+n', false)).toBe(
        true,
      );
    });

    it('matches either combo of a sequence format when passed directly', () => {
      expect(eventMatchesBinding(makeEvent({ key: 'i' }), 'g i', false)).toBe(true);
    });
  });

  describe('captureBinding', () => {
    it('captures mod+n on windows as mod+n', () => {
      const event = makeEvent({ key: 'n', ctrlKey: true });
      expect(captureBinding(event, false)).toBe('mod+n');
    });

    it('captures cmd+n on mac as mod+n', () => {
      const event = makeEvent({ key: 'n', metaKey: true });
      expect(captureBinding(event, true)).toBe('mod+n');
    });

    it('captures multi-modifier combos', () => {
      const event = makeEvent({ key: 'z', metaKey: true, shiftKey: true });
      expect(captureBinding(event, true)).toBe('mod+shift+z');
    });

    it('returns null for bare modifier keys', () => {
      expect(captureBinding(makeEvent({ key: 'Control' }), false)).toBeNull();
      expect(captureBinding(makeEvent({ key: 'Shift' }), false)).toBeNull();
    });
  });

  describe('formatBindingForDisplay', () => {
    it('shows mac symbols', () => {
      expect(formatBindingForDisplay('mod+z', true)).toBe('⌘Z');
      expect(formatBindingForDisplay('mod+shift+z', true)).toBe('⌘⇧Z');
      expect(formatBindingForDisplay('alt+f', true)).toBe('⌥F');
    });

    it('shows windows labels', () => {
      expect(formatBindingForDisplay('mod+z', false)).toBe('Ctrl+Z');
      expect(formatBindingForDisplay('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
    });

    it('formats sequences', () => {
      expect(formatBindingForDisplay('g i', false)).toBe('G → I');
    });
  });

  describe('isInputElement', () => {
    it('returns true for inputs and textareas', () => {
      const input = document.createElement('input');
      expect(isInputElement(input)).toBe(true);
      const textarea = document.createElement('textarea');
      expect(isInputElement(textarea)).toBe(true);
    });

    it('returns true for contenteditable elements', () => {
      const div = document.createElement('div');
      div.setAttribute('contenteditable', 'true');
      expect(isInputElement(div)).toBe(true);
    });

    it('returns false for plain elements', () => {
      expect(isInputElement(document.createElement('div'))).toBe(false);
    });
  });

  describe('bindingNeedsInputGuard', () => {
    it('guards single-character keys', () => {
      expect(bindingNeedsInputGuard('j')).toBe(true);
    });

    it('does not guard modifier combos', () => {
      expect(bindingNeedsInputGuard('mod+n')).toBe(false);
    });

    it('guards sequences', () => {
      expect(bindingNeedsInputGuard('g i')).toBe(true);
    });
  });
});
