import type { PluginAPI } from '../../src/services/plugins/pluginAPI';

export function activate(api: PluginAPI) {
  api.registerAction('example:say-hello', () => {
    console.log('Hello from example plugin');
  });
}

export function deactivate() {
  // cleanup
}
