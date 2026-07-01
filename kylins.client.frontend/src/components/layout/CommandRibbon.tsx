import { ReadRibbon } from './ribbon/ReadRibbon';
import { ComposeRibbon } from './ribbon/ComposeRibbon';

export type RibbonMode = 'read' | 'compose';

export interface CommandRibbonProps {
  mode?: RibbonMode;
}

export function CommandRibbon({ mode = 'read' }: CommandRibbonProps) {
  return mode === 'compose' ? <ComposeRibbon /> : <ReadRibbon />;
}
