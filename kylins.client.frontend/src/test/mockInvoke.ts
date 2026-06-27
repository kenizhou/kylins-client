// Shared test helper for the Task 5 cutover. The cutover modules now route
// through `invoke('db_*')` instead of `getDb()` from plugin-sql, so their tests
// need a default `invoke` mock that returns sane values for every `db_*`
// command they call. Tests override specific commands as needed.
//
// Vitest hoists `vi.mock(...)` above imports, so the mock factory cannot
// reference a top-level `mockInvoke` binding. Instead, each test file creates
// its own mock fn via `vi.hoisted` and passes it to `wireDefaultDbResults`,
// which installs the default dispatch. The shared `defaultDbResult` map lives
// here so every cutover module's tests agree on the sane defaults.
//
// Usage:
//   import { wireDefaultDbResults, defaultDbResult } from '@/test/mockInvoke';
//   const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
//   vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
//   beforeEach(() => wireDefaultDbResults(mockInvoke));
//   it('...', async () => {
//     mockInvoke.mockResolvedValueOnce(...);
//     ...
//   });

import type { Mock } from 'vitest';

/** Default sane return values for every `db_*` command the cutover modules
 *  issue. Returns a fresh object per call so tests can mutate without leaking
 *  across cases. */
export function defaultDbResult(cmd: string, args: Record<string, unknown> | undefined): unknown {
  switch (cmd) {
    // accounts
    case 'db_get_all_accounts':
      return [];
    case 'db_get_account_by_id':
    case 'db_get_account_by_email':
    case 'db_get_default_account':
      return null;
    case 'db_create_account':
      return {
        id: 'acct-1',
        email: (args?.input as { email?: string } | undefined)?.email ?? 'e@x.com',
        provider: (args?.input as { provider?: string } | undefined)?.provider ?? 'imap',
        isActive: true,
        isDefault: false,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      };
    case 'db_update_account':
    case 'db_delete_account':
    case 'db_delete_account_by_email':
    case 'db_set_default_account':
      return undefined;
    case 'db_get_account_count':
      return 0;

    // settings
    case 'db_get_setting':
    case 'db_get_setting_bool':
    case 'db_get_setting_number':
      return null;
    case 'db_set_setting':
    case 'db_set_setting_bool':
    case 'db_set_setting_number':
      return undefined;

    // labels / folders
    case 'db_get_folders_by_account':
    case 'db_get_all_folders':
    case 'db_upsert_folders':
      return [];
    case 'db_get_folder_by_role':
      return null;
    case 'db_get_unread_counts_by_account':
      return {};
    case 'db_create_folder':
      return {
        id: 'folder-1',
        accountId: (args as { accountId?: string } | undefined)?.accountId ?? 'acc-1',
        source: 'local',
        role: null,
        name: (args as { name?: string } | undefined)?.name ?? 'Folder',
        parentId: null,
        remoteId: 'folder-1',
        delimiter: null,
        unreadCount: 0,
        totalCount: 0,
        sortOrder: 0,
        visible: true,
        hierarchicalName: null,
        mailClass: 'mail',
      };
    case 'db_rename_folder':
    case 'db_delete_folder':
      return undefined;

    // threads
    case 'db_get_threads':
      return { threads: [], nextCursor: null };
    case 'db_get_messages_for_thread':
      return [];
    case 'db_mark_thread_read':
      return undefined;

    // message bodies
    case 'db_get_message_body':
      return null;
    case 'db_set_message_body':
    case 'db_evict_body':
      return undefined;

    // offline queue
    case 'db_enqueue_op':
      return 'op-1';
    case 'db_dequeue_pending':
      return [];
    case 'db_mark_op_completed':
    case 'db_mark_op_failed':
      return undefined;

    default:
      return undefined;
  }
}

/** Wire `mock` to dispatch to [`defaultDbResult`] by default. Resets the mock
 *  first so per-test `mockResolvedValueOnce` overrides don't leak across cases.
 *  Tests can still override a single command via `mockImplementation` or
 *  `mockResolvedValueOnce`. */
export function wireDefaultDbResults(mock: Mock): void {
  mock.mockReset();
  mock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) =>
    defaultDbResult(cmd, args),
  );
}
