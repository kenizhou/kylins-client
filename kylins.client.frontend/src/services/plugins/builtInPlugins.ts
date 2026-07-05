import { pluginManager } from './pluginManager';
import { TaskActionButton } from '@/components/tasks/TaskActionButton';
import { TaskThreadSidebar } from '@/components/tasks/TaskThreadSidebar';

export function activateBuiltInPlugins() {
  const api = pluginManager.api;
  if (!api) return;
  api.registerComponent('reading-pane:actions', TaskActionButton);
  api.registerComponent('reading-pane:footer', TaskThreadSidebar);
}
