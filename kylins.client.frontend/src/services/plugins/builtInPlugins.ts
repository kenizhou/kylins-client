import { pluginManager } from './pluginManager';

export function activateBuiltInPlugins() {
  const api = pluginManager.api;
  if (!api) return;
  // No built-in UI injections right now. Task components were removed from the
  // reading pane (reading-pane:actions / reading-pane:footer) — re-register
  // here if a built-in slot injection is needed again.
}
