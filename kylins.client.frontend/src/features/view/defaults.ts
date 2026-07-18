import type { ColumnDef, PanelSizeMap, ViewState } from './types';

export const DEFAULT_MESSAGE_LIST_COLUMNS: ColumnDef[] = [
  {
    id: 'threadRibbon',
    label: '',
    defaultVisible: true,
    sortable: false,
    resizable: false,
    renderer: 'threadRibbon',
  },
  {
    id: 'importance',
    label: 'Imp.',
    defaultVisible: false,
    sortable: false,
    resizable: false,
    renderer: 'importance',
  },
  {
    id: 'flag',
    label: 'Flag',
    defaultVisible: true,
    sortable: true,
    resizable: false,
    renderer: 'flag',
  },
  {
    id: 'from',
    label: 'From',
    defaultVisible: true,
    width: 180,
    sortable: true,
    resizable: true,
    renderer: 'from',
  },
  {
    id: 'subject',
    label: 'Subject',
    defaultVisible: true,
    width: 320,
    sortable: true,
    resizable: true,
    renderer: 'subject',
  },
  {
    id: 'snippet',
    label: 'Snippet',
    defaultVisible: false,
    width: 200,
    sortable: false,
    resizable: true,
    renderer: 'snippet',
  },
  {
    id: 'category',
    label: 'Category',
    defaultVisible: false,
    width: 120,
    sortable: false,
    resizable: true,
    renderer: 'category',
  },
  {
    id: 'received',
    label: 'Received',
    defaultVisible: true,
    width: 140,
    sortable: true,
    resizable: true,
    renderer: 'received',
  },
  {
    id: 'size',
    label: 'Size',
    defaultVisible: false,
    width: 80,
    sortable: true,
    resizable: true,
    renderer: 'size',
  },
  {
    id: 'attachments',
    label: '',
    defaultVisible: false,
    sortable: false,
    resizable: false,
    renderer: 'attachments',
  },
];

export const DEFAULT_PANEL_SIZES: PanelSizeMap = {
  // Outlook-like proportions: folder ~200-260 px at common widths, generous
  // message list, reading pane getting the remaining space.
  right: { folder: 18, list: 38, reader: 44 },
  bottom: { folder: 20, list: 48, reader: 32 },
  off: { folder: 22, list: 78 },
};

export const DEFAULT_VIEW_STATE: ViewState = {
  readingPanePosition: 'right',
  folderPaneVisible: true,
  commandRibbonVisible: true,
  statusBarVisible: true,
  conversationView: false,
  messageListDensity: 'normal',
  visibleColumnIds: DEFAULT_MESSAGE_LIST_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id),
  panelSizes: DEFAULT_PANEL_SIZES,
  calendarPaneVisible: true,
  calendarPaneSize: 22,
};

export const COLUMN_REGISTRY = new Map(DEFAULT_MESSAGE_LIST_COLUMNS.map((c) => [c.id, c]));
