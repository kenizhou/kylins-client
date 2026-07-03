import { ReadRibbon } from './ribbon/ReadRibbon';
import { ComposeRibbon } from './ribbon/ComposeRibbon';

export type RibbonMode = 'read' | 'compose';

export interface CommandRibbonProps {
  mode?: RibbonMode;
  viewer?: boolean;
}

export function CommandRibbon({ mode = 'read', viewer = false }: CommandRibbonProps) {
  return mode === 'compose' ? <ComposeRibbon /> : <ReadRibbon viewer={viewer} />;
}
