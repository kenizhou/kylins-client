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

    // contacts (groups + CRUD) — empty/null defaults so list/get helpers
    // don't throw in components that call them during render.
    case 'db_list_contacts':
    case 'db_search_contacts':
      return [];
    case 'db_get_contact_by_id':
    case 'db_get_contact_by_email':
    case 'db_get_contact_by_external_id':
      return null;
    case 'db_create_contact':
      return {
        id: 'c-1',
        email: (args?.input as { email?: string } | undefined)?.email ?? 'c@x.com',
        displayName: null,
        avatarUrl: null,
        frequency: 0,
        lastContactedAt: null,
        firstContactedAt: null,
        notes: null,
        accountId: null,
        source: 'local',
        externalId: null,
        etag: null,
        rawVCard: null,
        isHidden: false,
        isReadonly: false,
        company: null,
        jobTitle: null,
        emails: [],
        phones: [],
        addresses: [],
        createdAt: 1,
        updatedAt: 1,
      };
    case 'db_update_contact':
    case 'db_delete_contact':
    case 'db_upsert_contact':
    case 'db_update_contact_avatar':
    case 'db_update_contact_notes':
      return undefined;
    case 'db_get_contact_stats':
      return { emailCount: 0, firstEmail: null, lastEmail: null };
    case 'db_get_recent_threads_with_contact':
    case 'db_get_attachments_from_contact':
    case 'db_get_contacts_from_same_domain':
      return [];
    case 'db_get_latest_auth_result':
      return null;
    case 'db_get_contact_groups':
    case 'db_get_groups_for_contact':
      return [];
    case 'db_get_contact_group_by_id':
      return null;
    case 'db_create_contact_group':
      return {
        id: 'g-1',
        accountId: null,
        source: 'local',
        externalId: null,
        name: 'Group',
        etag: null,
        isReadonly: false,
        createdAt: 1,
        updatedAt: 1,
      };
    case 'db_rename_contact_group':
    case 'db_delete_contact_group':
    case 'db_add_contact_to_group':
    case 'db_remove_contact_from_group':
      return undefined;
    case 'db_get_contact_ids_for_group':
      return [];

    // tasks
    case 'db_get_tasks_for_account':
    case 'db_get_tasks_for_thread':
    case 'db_get_task_tags':
      return [];
    case 'db_get_task_by_id':
      return null;
    case 'db_insert_task':
      return 'task-1';
    case 'db_update_task':
    case 'db_delete_task':
    case 'db_toggle_task_completed':
    case 'db_create_task_tag':
    case 'db_update_task_tag_color':
    case 'db_delete_task_tag':
      return undefined;

    // signatures / drafts / aliases / calendar / scheduled / templates /
    // contact_sync_state / image_allowlist / ai_cache / search — sane empty
    // defaults so any component calling them during render doesn't blow up.
    case 'db_get_signatures_for_account':
    case 'db_get_aliases_for_account':
    case 'db_get_calendar_events_for_account':
    case 'db_get_calendar_events_in_range':
    case 'db_get_pending_scheduled_emails':
    case 'db_get_scheduled_emails_for_account':
    case 'db_get_templates_for_account':
    case 'db_search_messages':
    case 'db_list_drafts_for_account':
      return [];
    case 'db_get_default_signature':
    case 'db_get_calendar_event_by_id':
    case 'db_get_draft':
    case 'db_get_latest_scheduled_email_for_account':
    case 'db_get_contact_sync_state':
      return null;
    case 'db_insert_signature':
    case 'db_insert_alias':
    case 'db_insert_calendar_event':
    case 'db_insert_scheduled_email':
    case 'db_insert_template':
    case 'db_create_draft':
      return 'new-id';
    case 'db_update_signature':
    case 'db_delete_signature':
    case 'db_update_draft':
    case 'db_delete_draft':
    case 'db_update_alias':
    case 'db_delete_alias':
    case 'db_update_calendar_event':
    case 'db_delete_calendar_event':
    case 'db_update_scheduled_email_status':
    case 'db_delete_scheduled_email':
    case 'db_set_scheduled_email_attachment_paths':
    case 'db_update_template':
    case 'db_delete_template':
    case 'db_set_contact_sync_state':
    case 'db_add_to_image_allowlist':
    case 'db_remove_from_image_allowlist':
    case 'db_cache_ai_result':
      return undefined;
    case 'db_is_image_allowlisted':
      return false;
    case 'db_get_cached_ai_result':
      return null;

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
