import { Panel, Group, Separator } from 'react-resizable-panels';
import type { ReactNode } from 'react';

export interface ResizablePanelDef {
  id: string;
  content: ReactNode;
  defaultSize: number;
  minSize: number;
  maxSize?: number;
  /** If false, the panel is not rendered and adjacent panels fill the space. */
  visible?: boolean;
  /** If true, the panel content is wrapped in a styled card surface. */
  card?: boolean;
  className?: string;
}

export interface ResizablePaneGroupProps {
  panels: ResizablePanelDef[];
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  onLayoutChanged?: (layout: Record<string, number>) => void;
}

function PanelCard({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
      {children}
    </div>
  );
}

export function ResizablePaneGroup({
  panels,
  orientation = 'horizontal',
  className,
  onLayoutChanged,
}: ResizablePaneGroupProps) {
  const visiblePanels = panels.filter((p) => p.visible !== false);
  return (
    <Group orientation={orientation} className={className} onLayoutChanged={onLayoutChanged}>
      {visiblePanels.map((panel) => (
        <Panel
          key={panel.id}
          id={panel.id}
          defaultSize={panel.defaultSize}
          minSize={panel.minSize}
          maxSize={panel.maxSize}
          className={panel.className}
        >
          {panel.card ? <PanelCard>{panel.content}</PanelCard> : panel.content}
        </Panel>
      ))}
      {visiblePanels.slice(0, -1).map((panel) => (
        <Separator
          key={`sep-${panel.id}`}
          className={
            orientation === 'horizontal'
              ? 'mx-1 w-1.5 rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--series-300)]'
              : 'my-1 h-1.5 rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--series-300)]'
          }
        />
      ))}
    </Group>
  );
}
