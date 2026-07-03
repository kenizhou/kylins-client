import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { FolderPane } from '../../../src/components/layout/FolderPane';
import { useAccountStore } from '../../../src/stores/accountStore';
import { useFolderStore } from '../../../src/stores/folderStore';
import type { Account } from '../../../src/types';
import type { MailFolder } from '../../../src/services/mail/folders';

// Avoid pulling in the plugin registry machinery during this layout test.
vi.mock('../../../src/components/plugins/InjectedComponentSet', () => ({
  InjectedComponentSet: () => null,
}));

const folder = (over: Partial<MailFolder>): MailFolder => {
  const id = over.id ?? 'inbox';
  return {
    id,
    accountId: 'acc-1',
    source: 'local',
    role: 'inbox',
    name: 'Inbox',
    parentId: null,
    remoteId: id,
    delimiter: null,
    unreadCount: 0,
    totalCount: 0,
    sortOrder: 0,
    visible: true,
    hierarchicalName: null,
    mailClass: 'mail',
    ...over,
  };
};

const account = { id: 'acc-1', email: 'a@b.com', provider: 'imap' } as unknown as Account;

beforeEach(() => {
  useAccountStore.setState({
    accounts: [account],
    activeAccountId: 'acc-1',
    defaultAccountId: 'acc-1',
  });
  useFolderStore.setState({
    byAccount: {
      'acc-1': [
        folder({ id: 'inbox', role: 'inbox', name: 'Inbox' }),
        folder({ id: 'todo', role: null, name: 'Todo' }),
      ],
    },
    favorites: new Set(),
    unreadCounts: {},
    selected: null,
    isLoading: false,
  });
});

describe('FolderPane', () => {
  it('renders system + user folders under the account, with no Favorites by default', () => {
    const { getByText, queryByText } = render(<FolderPane />);
    expect(getByText('Inbox')).toBeInTheDocument();
    expect(getByText('Todo')).toBeInTheDocument();
    expect(getByText('a@b.com')).toBeInTheDocument();
    expect(queryByText('Favorites')).not.toBeInTheDocument();
  });

  it('selects a folder on click', () => {
    const { getByText } = render(<FolderPane />);
    fireEvent.click(getByText('Inbox'));
    expect(useFolderStore.getState().selected).toEqual({ accountId: 'acc-1', labelId: 'inbox' });
  });

  it('shows a Favorites section once a folder is pinned', () => {
    useFolderStore.setState({ favorites: new Set(['acc-1__inbox']) });
    const { getByText } = render(<FolderPane />);
    expect(getByText('Favorites')).toBeInTheDocument();
  });

  it('renders a nested user folder under its parent', () => {
    useFolderStore.setState({
      byAccount: {
        'acc-1': [
          folder({ id: 'projects', role: null, name: 'Projects', remoteId: 'col-projects' }),
          folder({
            id: 'apollo',
            role: null,
            name: 'Apollo',
            remoteId: 'col-apollo',
            parentId: 'col-projects',
          }),
        ],
      },
    });
    const { getByText, getByLabelText } = render(<FolderPane />);
    expect(getByText('Projects')).toBeInTheDocument();
    // Folder levels are collapsed by default; expand Projects to reveal Apollo.
    fireEvent.click(getByLabelText('Expand folder'));
    expect(getByText('Apollo')).toBeInTheDocument();
  });
});

describe('FolderPane context menu', () => {
  it('enables Rename/Delete for a user folder', () => {
    const { getByText } = render(<FolderPane />);
    fireEvent.contextMenu(getByText('Todo'));
    expect(getByText('Rename Folder').closest('[role="menuitem"]')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(getByText('Delete Folder').closest('[role="menuitem"]')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('disables Rename/Delete for a system folder', () => {
    const { getByText } = render(<FolderPane />);
    fireEvent.contextMenu(getByText('Inbox'));
    expect(getByText('Rename Folder').closest('[role="menuitem"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(getByText('Delete Folder').closest('[role="menuitem"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('opens an inline create input from "New Subfolder"', () => {
    const { getByText, getByPlaceholderText } = render(<FolderPane />);
    fireEvent.contextMenu(getByText('Todo'));
    fireEvent.click(getByText('New Subfolder'));
    expect(getByPlaceholderText('Folder name')).toBeInTheDocument();
  });
});
