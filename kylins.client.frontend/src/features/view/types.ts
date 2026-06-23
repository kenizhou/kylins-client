export type ReadingPanePosition = 'right' | 'bottom' | 'off';
export type MessageListDensity = 'compact' | 'normal' | 'comfortable';
export type MessageListViewMode = 'messages' | 'conversations';

export interface ColumnDef {
  id: string;
  label: string;
  defaultVisible: boolean;
  width?: number;
  sortable: boolean;
  resizable: boolean;
  renderer: 'from' | 'subject' | 'received' | 'size' | 'flag' | 'category' | 'read' | 'importance';
}

export interface ViewState {
  readingPanePosition: ReadingPanePosition;
  folderPaneVisible: boolean;
  commandRibbonVisible: boolean;
  statusBarVisible: boolean;
  conversationView: boolean;
  messageListDensity: MessageListDensity;
  visibleColumnIds: string[];
}
