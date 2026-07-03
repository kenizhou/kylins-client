import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  eventMatchesCombo,
  parseBinding,
  isInputElement,
  bindingNeedsInputGuard,
  type ParsedCombo,
} from '../services/shortcuts/shortcutEngine';
import { shortcutManager } from '../services/shortcuts/shortcutManager';
import { SHORTCUT_COMMANDS } from '../services/shortcuts/shortcutDefaults';
import { useShortcutStore } from '../stores/shortcutStore';
import { usePreferencesStore } from '../stores/preferencesStore';
import { useViewStore } from '../features/view/viewStore';
import { useUIStore } from '../stores/uiStore';
import { openComposerWindow } from '../utils/composeWindow';
import { DEMO_MESSAGES } from '../data/demoMessages';
import { isMac } from '../utils/platform';
import { pluginManager } from '../services/plugins/pluginManager';
import { getSettingBool, setSettingBool } from '../services/settings';
import { SETTING_KEYS } from '../services/settingsKeys';

const SEQUENCE_TIMEOUT_MS = 1000;

const READING_PANE_CYCLE: Array<'right' | 'bottom' | 'off'> = ['right', 'bottom', 'off'];

function cycleReadingPane(current: string): 'right' | 'bottom' | 'off' {
  const idx = READING_PANE_CYCLE.indexOf(current as 'right' | 'bottom' | 'off');
  return READING_PANE_CYCLE[(idx + 1) % READING_PANE_CYCLE.length]!;
}

function selectMessageDelta(delta: number): void {
  const { selectedMessage, setSelectedMessage } = useViewStore.getState();
  const ids = DEMO_MESSAGES.map((m) => m.id);
  const currentId = selectedMessage?.id;
  const currentIdx = currentId ? ids.indexOf(currentId) : -1;
  const nextIdx = Math.max(0, Math.min(ids.length - 1, currentIdx + delta));
  setSelectedMessage(DEMO_MESSAGES[nextIdx]!);
}

function runDocumentCommand(command: string): void {
  try {
    document.execCommand(command, false);
  } catch {
    // ignore
  }
}

const ACTION_REGISTRY: Record<string, () => void | Promise<void>> = {
  'app:new-mail': () => openComposerWindow(),
  'app:add-account': () => useUIStore.getState().setAccountSetupOpen(true),
  'app:preferences': () => usePreferencesStore.getState().openPreferences('General'),
  'app:print': () => window.print(),
  'app:close-window': () => getCurrentWindow().close(),
  'app:reload': () => window.location.reload(),
  'app:show-shortcuts-help': () => usePreferencesStore.getState().openPreferences('Shortcuts'),

  'app:open-devtools': () => {
    void invoke('open_devtools');
  },
  'app:open-logs': () => {
    void invoke('reveal_logs_directory');
  },
  'app:preferences-appearance': () => usePreferencesStore.getState().openPreferences('Appearance'),
  'app:toggle-debug-flags': async () => {
    const current = (await getSettingBool(SETTING_KEYS.debugFlags)) ?? false;
    await setSettingBool(SETTING_KEYS.debugFlags, !current);
    window.location.reload();
  },
  'app:install-plugin': async () => {
    const path = await open({ multiple: false, directory: false });
    if (typeof path !== 'string') return;
    try {
      await pluginManager.installPlugin(path);
      console.log('[plugins] installed', path);
    } catch (err) {
      console.error('[plugins] failed to install plugin:', err);
    }
  },
  'app:create-plugin': async () => {
    const directory = await save({ defaultPath: 'my-kylins-plugin' });
    if (typeof directory !== 'string') return;
    try {
      const name = directory.split(/[\\/]/).pop() || 'my-kylins-plugin';
      await pluginManager.createPlugin(directory, name);
      console.log('[plugins] created plugin at', directory);
    } catch (err) {
      console.error('[plugins] failed to create plugin:', err);
    }
  },

  'edit:undo': () => runDocumentCommand('undo'),
  'edit:redo': () => runDocumentCommand('redo'),
  'edit:cut': () => runDocumentCommand('cut'),
  'edit:copy': () => runDocumentCommand('copy'),
  'edit:paste': () => runDocumentCommand('paste'),
  'edit:paste-and-match-style': () => {
    // Placeholder: browsers don't expose paste-and-match-style via execCommand.
    console.warn('[shortcuts] paste-and-match-style not yet implemented');
  },
  'edit:select-all': () => runDocumentCommand('selectAll'),
  'edit:find': () => {
    // TODO: focus reading-pane find input when implemented.
    console.warn('[shortcuts] find not yet implemented');
  },

  'view:toggle-folder-pane': () => {
    const { folderPaneVisible, setFolderPaneVisible } = useViewStore.getState();
    setFolderPaneVisible(!folderPaneVisible);
  },
  'view:toggle-command-ribbon': () => {
    const { commandRibbonVisible, setCommandRibbonVisible } = useViewStore.getState();
    setCommandRibbonVisible(!commandRibbonVisible);
  },
  'view:toggle-status-bar': () => {
    const { statusBarVisible, setStatusBarVisible } = useViewStore.getState();
    setStatusBarVisible(!statusBarVisible);
  },
  'view:reading-pane': () => {
    const { readingPanePosition, setReadingPanePosition } = useViewStore.getState();
    setReadingPanePosition(cycleReadingPane(readingPanePosition));
  },

  'mail:sync': () => {
    console.warn('[shortcuts] sync not yet implemented');
  },
  'mail:next-message': () => selectMessageDelta(1),
  'mail:prev-message': () => selectMessageDelta(-1),
  'mail:toggle-read': () => {
    console.warn('[shortcuts] toggle-read not yet implemented');
  },
  'mail:archive': () => {
    console.warn('[shortcuts] archive not yet implemented');
  },

  'go:mail': () => useUIStore.getState().setActiveApp('mail'),
  'go:calendar': () => useUIStore.getState().setActiveApp('calendar'),
  'go:inbox': () => {
    useUIStore.getState().setActiveApp('mail');
    console.warn('[shortcuts] go:inbox not yet implemented');
  },
  'go:sent': () => {
    useUIStore.getState().setActiveApp('mail');
    console.warn('[shortcuts] go:sent not yet implemented');
  },
  'go:drafts': () => {
    useUIStore.getState().setActiveApp('mail');
    console.warn('[shortcuts] go:drafts not yet implemented');
  },
};

export function executeCommand(commandId: string): void {
  const action = ACTION_REGISTRY[commandId];
  if (action) {
    try {
      void action();
    } catch (err) {
      console.error(`[shortcuts] action "${commandId}" failed:`, err);
    }
  } else {
    console.warn(`[shortcuts] no action registered for "${commandId}"`);
  }
}

export function useKeyboardShortcuts(): void {
  const isHydrated = useShortcutStore((s) => s.isHydrated);
  const activeSetRef = useRef(shortcutManager.getActiveSet());

  useEffect(() => {
    return useShortcutStore.subscribe((state) => {
      activeSetRef.current = state.activeSet;
    });
  }, []);

  useEffect(() => {
    if (!isHydrated) return;

    const mac = isMac();
    const keyMap = shortcutManager.getResolvedKeyMap();

    // Build reverse lookup tables fresh every time the active set changes.
    const singleCombos = new Map<string, string>();
    const sequenceFirstKeys = new Map<string, string>();
    const sequenceSecondCombos = new Map<string, ParsedCombo>();

    for (const command of SHORTCUT_COMMANDS) {
      const binding = keyMap[command.id];
      if (!binding) continue;
      const parsed = parseBinding(binding);
      if (parsed.combos.length === 1) {
        singleCombos.set(stringifyCombo(parsed.combos[0]!), command.id);
      } else if (parsed.combos.length === 2) {
        sequenceFirstKeys.set(parsed.combos[0]!.key, command.id);
        sequenceSecondCombos.set(command.id, parsed.combos[1]!);
      }
    }

    let pendingSequenceCommand: string | null = null;
    let sequenceTimer: ReturnType<typeof setTimeout> | null = null;

    function clearSequence() {
      pendingSequenceCommand = null;
      if (sequenceTimer) {
        clearTimeout(sequenceTimer);
        sequenceTimer = null;
      }
    }

    function startSequence(commandId: string) {
      pendingSequenceCommand = commandId;
      if (sequenceTimer) clearTimeout(sequenceTimer);
      sequenceTimer = setTimeout(clearSequence, SEQUENCE_TIMEOUT_MS);
    }

    function dispatch(commandId: string) {
      executeCommand(commandId);
    }

    function handleKeyDown(event: KeyboardEvent) {
      // Never intercept reload/close combos in development when DevTools is focused.
      if (event.repeat) return;

      if (pendingSequenceCommand) {
        const second = sequenceSecondCombos.get(pendingSequenceCommand);
        if (second && eventMatchesCombo(event, second, mac)) {
          event.preventDefault();
          clearSequence();
          dispatch(pendingSequenceCommand);
          return;
        }
        clearSequence();
      }

      const target = event.target;
      const isSingleModifierKey = ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key);
      if (isSingleModifierKey) return;

      // Single-character navigation shortcuts (e.g. "j"/"k") should not fire
      // while the user is typing in an input.
      if (isInputElement(target) && !event.ctrlKey && !event.metaKey) return;

      // Try sequence prefix first.
      const seqCommand = sequenceFirstKeys.get(event.key.toLowerCase());
      if (seqCommand) {
        event.preventDefault();
        startSequence(seqCommand);
        return;
      }

      // Try single combos.
      for (const [comboKey, commandId] of singleCombos.entries()) {
        const parsed = parseBinding(comboKey);
        const combo = parsed.combos[0]!;
        if (eventMatchesCombo(event, combo, mac)) {
          const binding = keyMap[commandId] ?? comboKey;
          if (isInputElement(target) && bindingNeedsInputGuard(binding)) return;
          // Standard edit commands (cut/copy/paste/undo/etc.) should not be
          // intercepted while the user is typing in an input. Let the browser's
          // native editing behavior run so clipboard operations actually work.
          if (commandId.startsWith('edit:') && isInputElement(target)) return;
          event.preventDefault();
          dispatch(commandId);
          return;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearSequence();
    };
  }, [isHydrated]);
}

function stringifyCombo(combo: ParsedCombo): string {
  const parts: string[] = [];
  if (combo.mod) parts.push('mod');
  if (combo.ctrl) parts.push('ctrl');
  if (combo.alt) parts.push('alt');
  if (combo.shift) parts.push('shift');
  parts.push(combo.key);
  return parts.join('+');
}
