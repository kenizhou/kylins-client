export interface ParsedCombo {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export interface ParsedBinding {
  /** One combo (e.g. "mod+n") or two (e.g. "g i"). */
  combos: ParsedCombo[];
}

const MODIFIER_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'CapsLock',
  'Tab',
  'Escape',
  'Backspace',
]);

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

export function parseBinding(input: string): ParsedBinding {
  const parts = input.split(/\s+/).filter(Boolean);
  const combos = parts.map((part) => {
    const tokens = part.split('+').map((t) => normalizeKey(t));
    const combo: ParsedCombo = { mod: false, ctrl: false, alt: false, shift: false, key: '' };
    for (const token of tokens) {
      switch (token) {
        case 'mod':
          combo.mod = true;
          break;
        case 'ctrl':
        case 'control':
          combo.ctrl = true;
          break;
        case 'alt':
        case 'option':
          combo.alt = true;
          break;
        case 'shift':
          combo.shift = true;
          break;
        default:
          combo.key = token;
          break;
      }
    }
    return combo;
  });
  return { combos };
}

function hasModifier(combo: ParsedCombo): boolean {
  return combo.mod || combo.ctrl || combo.alt || combo.shift;
}

export function eventMatchesCombo(event: KeyboardEvent, combo: ParsedCombo, isMac: boolean): boolean {
  const key = normalizeKey(event.key);
  if (key !== combo.key) return false;

  const expectsCtrl = combo.ctrl || (combo.mod && !isMac);
  const expectsMeta = combo.mod && isMac;

  if (event.ctrlKey !== expectsCtrl) return false;
  if (event.metaKey !== expectsMeta) return false;
  if (event.altKey !== combo.alt) return false;
  if (event.shiftKey !== combo.shift) return false;

  // Ensure no extra modifiers are pressed.
  if (!expectsCtrl && event.ctrlKey) return false;
  if (!expectsMeta && event.metaKey) return false;
  if (!combo.alt && event.altKey) return false;
  if (!combo.shift && event.shiftKey) return false;

  return true;
}

export function eventMatchesBinding(
  event: KeyboardEvent,
  binding: string,
  isMac: boolean,
): boolean {
  const parsed = parseBinding(binding);
  return parsed.combos.some((combo) => eventMatchesCombo(event, combo, isMac));
}

export function isInputElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if (target.isContentEditable) return true;
  const editableAttr = target.getAttribute('contenteditable');
  if (editableAttr === 'true' || editableAttr === '') return true;
  return false;
}

export function bindingNeedsInputGuard(binding: string): boolean {
  const parsed = parseBinding(binding);
  // Sequences and single-character shortcuts without modifiers are guarded.
  if (parsed.combos.length > 1) return true;
  return !hasModifier(parsed.combos[0]!);
}

export function captureBinding(event: KeyboardEvent, isMac: boolean): string | null {
  // Ignore bare modifier keypresses and a few navigation keys.
  if (MODIFIER_KEYS.has(event.key)) return null;

  const parts: string[] = [];
  if (isMac) {
    if (event.metaKey) parts.push('mod');
    if (event.ctrlKey) parts.push('ctrl');
  } else {
    if (event.ctrlKey) parts.push('mod');
    if (event.metaKey) parts.push('meta');
  }
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');

  const key = normalizeKey(event.key);
  parts.push(key);

  return parts.join('+');
}

export function formatBindingForDisplay(binding: string, isMac: boolean): string {
  const parsed = parseBinding(binding);
  const formatCombo = (combo: ParsedCombo): string => {
    const parts: string[] = [];
    if (combo.mod) parts.push(isMac ? '⌘' : 'Ctrl');
    if (combo.ctrl) parts.push(isMac ? '⌃' : 'Ctrl');
    if (combo.alt) parts.push(isMac ? '⌥' : 'Alt');
    if (combo.shift) parts.push(isMac ? '⇧' : 'Shift');
    parts.push(formatKey(combo.key, isMac));
    return parts.join(isMac ? '' : '+');
  };

  if (parsed.combos.length === 1) {
    return formatCombo(parsed.combos[0]!);
  }
  return parsed.combos.map(formatCombo).join(isMac ? ' ' : ' → ');
}

function formatKey(key: string, isMac: boolean): string {
  switch (key.toLowerCase()) {
    case 'arrowup':
      return isMac ? '↑' : 'Up';
    case 'arrowdown':
      return isMac ? '↓' : 'Down';
    case 'arrowleft':
      return isMac ? '←' : 'Left';
    case 'arrowright':
      return isMac ? '→' : 'Right';
    case 'escape':
      return 'Esc';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

export function getKeyForSequence(binding: string): string | null {
  const parsed = parseBinding(binding);
  if (parsed.combos.length !== 2) return null;
  return stringifyCombo(parsed.combos[0]!);
}

export function stringifyCombo(combo: ParsedCombo): string {
  const parts: string[] = [];
  if (combo.mod) parts.push('mod');
  if (combo.ctrl) parts.push('ctrl');
  if (combo.alt) parts.push('alt');
  if (combo.shift) parts.push('shift');
  parts.push(combo.key);
  return parts.join('+');
}
