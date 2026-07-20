import { useRef } from 'react';
import { Panel, Group, Separator, type GroupImperativeHandle } from 'react-resizable-panels';
import type { ReadingPanePosition, PanelSizeMap } from '../types';
import { useViewStore } from '../viewStore';
import { useWindowSize } from '../../../hooks/useWindowSize';
import { FolderPaneDrawer } from '../../../components/layout/FolderPaneDrawer';
import { VDivider } from './VDivider';

interface ReadingPaneLayoutProps {
  folderPaneVisible: boolean;
  folderPane: React.ReactNode;
  messageList: React.ReactNode;
  readingPane: React.ReactNode;
}

function PanelCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative h-full overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--card)] shadow-md"
      style={{
        maskImage:
          'radial-gradient(circle at 0 100%, transparent 12px, black 12px), radial-gradient(circle at 100% 100%, transparent 12px, black 12px)',
        WebkitMaskImage:
          'radial-gradient(circle at 0 100%, transparent 12px, black 12px), radial-gradient(circle at 100% 100%, transparent 12px, black 12px)',
        maskComposite: 'add',
        WebkitMaskComposite: 'source-over',
      }}
    >
      {children}
    </div>
  );
}

function HDivider() {
  return (
    <Separator className="my-1 h-1.5 rounded-full bg-[var(--border)] transition-colors hover:bg-[var(--series-300)]" />
  );
}

// Simple, stable percentage minimums. Max is left unset so panels can grow
// until they bump into an adjacent panel's minimum; this avoids any chance of
// conflicting min/max constraints.
const OFF_CONSTRAINTS = {
  folder: { min: 12 },
  list: { min: 40 },
} as const;
const RIGHT_CONSTRAINTS = {
  folder: { min: 12 },
  list: { min: 18 },
  reader: { min: 30 },
} as const;
const BOTTOM_OUTER_CONSTRAINTS = {
  folder: { min: 12 },
  content: { min: 30 },
} as const;
const BOTTOM_INNER_CONSTRAINTS = {
  list: { min: 25 },
  reader: { min: 20 },
} as const;

function scaleTo(total: number, values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum === 0) return values.map(() => total / values.length);
  return values.map((v) => (v / sum) * total);
}

function normalizeSizes(sizes: Record<string, number>): Record<string, number> {
  const sum = Object.values(sizes).reduce((a, b) => a + b, 0);
  if (sum === 0) return sizes;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(sizes)) {
    result[key] = (value / sum) * 100;
  }
  return result;
}

function buildOuterLayout(
  position: ReadingPanePosition,
  panelSizes: PanelSizeMap,
  showFolderPane: boolean,
): Record<string, number> {
  if (position === 'off') {
    if (showFolderPane) {
      return normalizeSizes({
        'folder-pane': panelSizes.off.folder,
        'message-list': panelSizes.off.list,
      });
    }
    return { 'message-list': 100 };
  }

  if (position === 'right') {
    if (showFolderPane) {
      return normalizeSizes({
        'folder-pane': panelSizes.right.folder,
        'message-list': panelSizes.right.list,
        'reading-pane': panelSizes.right.reader,
      });
    }
    // Folder hidden: scale list/reader up so the visible panes fill 100%.
    const [list, reader] = scaleTo(100, [panelSizes.right.list, panelSizes.right.reader]);
    return { 'message-list': list ?? 0, 'reading-pane': reader ?? 0 };
  }

  // bottom: outer group is folder-pane | content (the inner vertical group).
  if (showFolderPane) {
    return normalizeSizes({
      'folder-pane': panelSizes.bottom.folder,
      content: panelSizes.bottom.list + panelSizes.bottom.reader,
    });
  }
  return { content: 100 };
}

function buildInnerBottomLayout(panelSizes: PanelSizeMap): Record<string, number> {
  const { list, reader } = panelSizes.bottom;
  const [innerList, innerReader] = scaleTo(100, [list, reader]);
  return { 'message-list': innerList ?? 0, 'reading-pane': innerReader ?? 0 };
}

function writeOuterLayout(
  position: ReadingPanePosition,
  layout: Record<string, number>,
  panelSizes: PanelSizeMap,
  showFolderPane: boolean,
  setPanelSizes: <P extends ReadingPanePosition>(position: P, sizes: PanelSizeMap[P]) => void,
) {
  if (position === 'off') {
    if (showFolderPane) {
      setPanelSizes('off', {
        folder: layout['folder-pane'] ?? 20,
        list: layout['message-list'] ?? 80,
      });
    }
    return;
  }

  if (position === 'right') {
    if (showFolderPane) {
      setPanelSizes('right', {
        folder: layout['folder-pane'] ?? 20,
        list: layout['message-list'] ?? 30,
        reader: layout['reading-pane'] ?? 50,
      });
      return;
    }
    // Folder hidden: convert visible percentages back to the full-width values
    // so toggling folder visibility restores the previous layout.
    const available = 100 - panelSizes.right.folder;
    const listScaled = layout['message-list'] ?? 50;
    const readerScaled = layout['reading-pane'] ?? 50;
    setPanelSizes('right', {
      folder: panelSizes.right.folder,
      list: (listScaled / 100) * available,
      reader: (readerScaled / 100) * available,
    });
    return;
  }

  // bottom: outer layout only controls folder vs content width. Keep the
  // list+reader share proportional to the remaining space so the three values
  // always sum to 100 and the inner vertical group stays stable.
  if (showFolderPane) {
    const folder = layout['folder-pane'] ?? panelSizes.bottom.folder;
    const content = layout['content'] ?? 100 - folder;
    const currentContent = panelSizes.bottom.list + panelSizes.bottom.reader;
    const scale = currentContent === 0 ? 1 : content / currentContent;
    setPanelSizes('bottom', {
      folder,
      list: panelSizes.bottom.list * scale,
      reader: panelSizes.bottom.reader * scale,
    });
  }
}

function writeInnerBottomLayout(
  layout: Record<string, number>,
  panelSizes: PanelSizeMap,
  outerGroupRef: React.RefObject<GroupImperativeHandle | null>,
  setPanelSizes: <P extends ReadingPanePosition>(position: P, sizes: PanelSizeMap[P]) => void,
) {
  const outerLayout = outerGroupRef.current?.getLayout();
  const content = outerLayout?.['content'] ?? 100 - panelSizes.bottom.folder;
  setPanelSizes('bottom', {
    folder: outerLayout?.['folder-pane'] ?? panelSizes.bottom.folder,
    list: ((layout['message-list'] ?? 50) / 100) * content,
    reader: ((layout['reading-pane'] ?? 50) / 100) * content,
  });
}

export function ReadingPaneLayout({
  folderPaneVisible,
  folderPane,
  messageList,
  readingPane,
}: ReadingPaneLayoutProps) {
  const position = useViewStore((s) => s.readingPanePosition);
  const panelSizes = useViewStore((s) => s.panelSizes);
  const setPanelSizes = useViewStore((s) => s.setPanelSizes);
  const setFolderPaneVisible = useViewStore((s) => s.setFolderPaneVisible);
  const { breakpoint } = useWindowSize();

  // Compact windows collapse to a single message-list surface.
  const isCompact = breakpoint === 'compact';
  const effectivePosition: ReadingPanePosition = isCompact ? 'off' : position;

  const showFolderPane = !isCompact && folderPaneVisible;

  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const bottomInnerRef = useRef<GroupImperativeHandle | null>(null);

  function handleOuterLayoutChanged(layout: Record<string, number>) {
    const currentSizes = useViewStore.getState().panelSizes;
    writeOuterLayout(effectivePosition, layout, currentSizes, showFolderPane, setPanelSizes);
  }

  function handleInnerBottomLayoutChanged(layout: Record<string, number>) {
    const currentSizes = useViewStore.getState().panelSizes;
    writeInnerBottomLayout(layout, currentSizes, groupRef, setPanelSizes);
  }

  // Stable percentage constraints; max is left unset so panels can grow until
  // they hit an adjacent panel's minimum. This is the simplest, most stable
  // configuration and avoids any chance of conflicting min/max constraints.
  const offConstraints = OFF_CONSTRAINTS;
  const rightConstraints = RIGHT_CONSTRAINTS;
  const bottomOuterConstraints = BOTTOM_OUTER_CONSTRAINTS;
  const bottomInnerConstraints = BOTTOM_INNER_CONSTRAINTS;

  // Compact drawer state mirrors the folder-pane toggle.
  const drawerOpen = isCompact && folderPaneVisible;

  const outerLayout = buildOuterLayout(effectivePosition, panelSizes, showFolderPane);
  const innerBottomLayout = buildInnerBottomLayout(panelSizes);

  // Flat layout: folder pane + message list only.
  if (effectivePosition === 'off') {
    return (
      <>
        <Group
          key={effectivePosition}
          groupRef={groupRef}
          orientation="horizontal"
          className="flex-1 p-2"
          onLayoutChanged={handleOuterLayoutChanged}
        >
          {showFolderPane && (
            <Panel
              id="folder-pane"
              defaultSize={outerLayout['folder-pane']}
              minSize={offConstraints.folder.min}
            >
              {folderPane}
            </Panel>
          )}
          {showFolderPane && <VDivider invisible />}
          <Panel
            id="message-list"
            defaultSize={outerLayout['message-list']}
            minSize={offConstraints.list.min}
          >
            <PanelCard>{messageList}</PanelCard>
          </Panel>
        </Group>

        {drawerOpen && (
          <FolderPaneDrawer open={drawerOpen} onClose={() => setFolderPaneVisible(false)}>
            {folderPane}
          </FolderPaneDrawer>
        )}
      </>
    );
  }

  // Flat layout: folder + message list + reading pane side by side.
  if (effectivePosition === 'right') {
    return (
      <>
        <Group
          key={effectivePosition}
          groupRef={groupRef}
          orientation="horizontal"
          className="flex-1 p-2"
          onLayoutChanged={handleOuterLayoutChanged}
        >
          {showFolderPane && (
            <Panel
              id="folder-pane"
              defaultSize={outerLayout['folder-pane']}
              minSize={rightConstraints.folder.min}
            >
              {folderPane}
            </Panel>
          )}
          {showFolderPane && <VDivider invisible />}
          <Panel
            id="message-list"
            defaultSize={outerLayout['message-list']}
            minSize={rightConstraints.list.min}
          >
            <PanelCard>{messageList}</PanelCard>
          </Panel>
          <VDivider />
          <Panel
            id="reading-pane"
            defaultSize={outerLayout['reading-pane']}
            minSize={rightConstraints.reader.min}
          >
            <PanelCard>{readingPane}</PanelCard>
          </Panel>
        </Group>

        {drawerOpen && (
          <FolderPaneDrawer open={drawerOpen} onClose={() => setFolderPaneVisible(false)}>
            {folderPane}
          </FolderPaneDrawer>
        )}
      </>
    );
  }

  // Bottom: folder | (message list / reading pane stacked vertically).
  return (
    <>
      <Group
        key={effectivePosition}
        groupRef={groupRef}
        orientation="horizontal"
        className="flex-1 p-2"
        onLayoutChanged={handleOuterLayoutChanged}
      >
        {showFolderPane && (
          <Panel
            id="folder-pane"
            defaultSize={outerLayout['folder-pane']}
            minSize={bottomOuterConstraints.folder.min}
          >
            {folderPane}
          </Panel>
        )}
        {showFolderPane && <VDivider />}
        <Panel
          id="content"
          defaultSize={outerLayout['content']}
          minSize={bottomOuterConstraints.content.min}
        >
          <Group
            groupRef={bottomInnerRef}
            orientation="vertical"
            className="h-full"
            onLayoutChanged={handleInnerBottomLayoutChanged}
          >
            <Panel
              id="message-list"
              defaultSize={innerBottomLayout['message-list']}
              minSize={bottomInnerConstraints.list.min}
            >
              <PanelCard>{messageList}</PanelCard>
            </Panel>
            <HDivider />
            <Panel
              id="reading-pane"
              defaultSize={innerBottomLayout['reading-pane']}
              minSize={bottomInnerConstraints.reader.min}
            >
              <PanelCard>{readingPane}</PanelCard>
            </Panel>
          </Group>
        </Panel>
      </Group>

      {drawerOpen && (
        <FolderPaneDrawer open={drawerOpen} onClose={() => setFolderPaneVisible(false)}>
          {folderPane}
        </FolderPaneDrawer>
      )}
    </>
  );
}
