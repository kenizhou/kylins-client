import type { ColumnDef, ViewState } from './types';

export const DEFAULT_MESSAGE_LIST_COLUMNS: ColumnDef[] = [
  {
    id: 'read',
    label: 'Read',
    defaultVisible: false,
    sortable: true,
    resizable: false,
    renderer: 'read',
  },
  {
    id: 'importance',
    label: 'Importance',
    defaultVisible: false,
    sortable: true,
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
    id: 'category',
    label: 'Category',
    defaultVisible: false,
    width: 120,
    sortable: true,
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
];

export const DEFAULT_VIEW_STATE: ViewState = {
  readingPanePosition: 'right',
  folderPaneVisible: true,
  commandRibbonVisible: true,
  statusBarVisible: true,
  conversationView: false,
  messageListDensity: 'normal',
  visibleColumnIds: DEFAULT_MESSAGE_LIST_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id),
};

export const COLUMN_REGISTRY = new Map(DEFAULT_MESSAGE_LIST_COLUMNS.map((c) => [c.id, c]));
