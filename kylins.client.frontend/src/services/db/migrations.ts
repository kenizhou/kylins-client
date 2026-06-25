// Ported from velo (https://github.com/avihaymenahem/velo)
// Licensed under Apache-2.0. See ATTRIBUTIONS.md.

import { getDb } from './connection';

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema',
    sql: `
      -- Accounts
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT,
        avatar_url TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at INTEGER,
        history_id TEXT,
        last_sync_at INTEGER,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );

      -- Labels
      CREATE TABLE IF NOT EXISTS labels (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        color_bg TEXT,
        color_fg TEXT,
        visible INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        PRIMARY KEY (account_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_labels_account ON labels(account_id);

      -- Threads
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        subject TEXT,
        snippet TEXT,
        last_message_at INTEGER,
        message_count INTEGER DEFAULT 0,
        is_read INTEGER DEFAULT 0,
        is_starred INTEGER DEFAULT 0,
        is_important INTEGER DEFAULT 0,
        has_attachments INTEGER DEFAULT 0,
        is_snoozed INTEGER DEFAULT 0,
        snooze_until INTEGER,
        PRIMARY KEY (account_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_threads_date ON threads(account_id, last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_snoozed ON threads(is_snoozed, snooze_until);

      -- Thread-Label junction
      CREATE TABLE IF NOT EXISTS thread_labels (
        thread_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        label_id TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id, label_id),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_thread_labels_label ON thread_labels(account_id, label_id);

      -- Messages
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        from_address TEXT,
        from_name TEXT,
        to_addresses TEXT,
        cc_addresses TEXT,
        bcc_addresses TEXT,
        reply_to TEXT,
        subject TEXT,
        snippet TEXT,
        date INTEGER NOT NULL,
        is_read INTEGER DEFAULT 0,
        is_starred INTEGER DEFAULT 0,
        body_html TEXT,
        body_text TEXT,
        body_cached INTEGER DEFAULT 0,
        raw_size INTEGER,
        internal_date INTEGER,
        PRIMARY KEY (account_id, id),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id, date ASC);
      CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(account_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_address);

      -- Attachments
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        filename TEXT,
        mime_type TEXT,
        size INTEGER,
        gmail_attachment_id TEXT,
        content_id TEXT,
        is_inline INTEGER DEFAULT 0,
        local_path TEXT,
        FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(account_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_cid ON attachments(content_id);

      -- Contacts
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT,
        avatar_url TEXT,
        frequency INTEGER DEFAULT 1,
        last_contacted_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
      CREATE INDEX IF NOT EXISTS idx_contacts_frequency ON contacts(frequency DESC);

      -- Signatures
      CREATE TABLE IF NOT EXISTS signatures (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        body_html TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );

      -- Scheduled emails
      CREATE TABLE IF NOT EXISTS scheduled_emails (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        to_addresses TEXT NOT NULL,
        cc_addresses TEXT,
        bcc_addresses TEXT,
        subject TEXT,
        body_html TEXT NOT NULL,
        reply_to_message_id TEXT,
        thread_id TEXT,
        scheduled_at INTEGER NOT NULL,
        signature_id TEXT,
        attachment_paths TEXT,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_emails(status, scheduled_at);

      -- App settings
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('theme', 'system'),
        ('sidebar_collapsed', 'false'),
        ('reading_pane_position', 'right'),
        ('sync_period_days', '365'),
        ('notifications_enabled', 'true'),
        ('undo_send_delay_seconds', '5'),
        ('default_font', 'system'),
        ('font_size', 'default');

      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        description TEXT,
        applied_at INTEGER DEFAULT (unixepoch())
      );
    `,
  },
  {
    version: 2,
    description: 'Full-text search',
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        subject,
        from_name,
        from_address,
        body_text,
        snippet,
        content='messages',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text, snippet)
        VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.snippet);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text, snippet)
        VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.snippet);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, body_text, snippet)
        VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.body_text, old.snippet);
        INSERT INTO messages_fts(rowid, subject, from_name, from_address, body_text, snippet)
        VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.body_text, new.snippet);
      END;
    `,
  },
  {
    version: 3,
    description: 'Add List-Unsubscribe header storage',
    sql: `ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;`,
  },
  {
    version: 4,
    description: 'Filter rules, templates, image allowlist',
    sql: `
      CREATE TABLE IF NOT EXISTS filter_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        is_enabled INTEGER DEFAULT 1,
        criteria_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_filter_rules_account ON filter_rules(account_id);

      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        name TEXT NOT NULL,
        subject TEXT,
        body_html TEXT NOT NULL,
        shortcut TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_templates_account ON templates(account_id);

      CREATE TABLE IF NOT EXISTS image_allowlist (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        sender_address TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, sender_address)
      );
      CREATE INDEX IF NOT EXISTS idx_image_allowlist_sender ON image_allowlist(account_id, sender_address);

      INSERT OR IGNORE INTO settings (key, value) VALUES ('block_remote_images', 'true');
    `,
  },
  {
    version: 5,
    description:
      'Pin support, AI cache, thread categories, calendar events, contact enrichment, attachment caching',
    sql: `
      ALTER TABLE threads ADD COLUMN is_pinned INTEGER DEFAULT 0;
      CREATE INDEX idx_threads_pinned ON threads(account_id, is_pinned DESC, last_message_at DESC);

      CREATE TABLE ai_cache (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, thread_id, type)
      );
      CREATE INDEX idx_ai_cache_lookup ON ai_cache(account_id, thread_id, type);

      CREATE TABLE thread_categories (
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        category TEXT NOT NULL,
        is_manual INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, thread_id),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX idx_thread_categories_cat ON thread_categories(account_id, category);

      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        google_event_id TEXT NOT NULL,
        summary TEXT,
        description TEXT,
        location TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        is_all_day INTEGER DEFAULT 0,
        status TEXT DEFAULT 'confirmed',
        organizer_email TEXT,
        attendees_json TEXT,
        html_link TEXT,
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, google_event_id)
      );
      CREATE INDEX idx_cal_events_time ON calendar_events(account_id, start_time, end_time);

      ALTER TABLE contacts ADD COLUMN first_contacted_at INTEGER;

      ALTER TABLE attachments ADD COLUMN cached_at INTEGER;
      ALTER TABLE attachments ADD COLUMN cache_size INTEGER;

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('ai_enabled', 'true'),
        ('ai_auto_categorize', 'true'),
        ('ai_auto_summarize', 'true'),
        ('contact_sidebar_visible', 'true'),
        ('attachment_cache_max_mb', '500'),
        ('calendar_enabled', 'false');
    `,
  },
  {
    version: 6,
    description:
      'Follow-up reminders, smart notifications, unsubscribe manager, newsletter bundling',
    sql: `
      CREATE TABLE IF NOT EXISTS follow_up_reminders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        remind_at INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX idx_followup_status ON follow_up_reminders(status, remind_at);
      CREATE INDEX idx_followup_thread ON follow_up_reminders(account_id, thread_id);

      CREATE TABLE IF NOT EXISTS notification_vips (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        email_address TEXT NOT NULL,
        display_name TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, email_address)
      );
      CREATE INDEX idx_notification_vips ON notification_vips(account_id, email_address);

      CREATE TABLE IF NOT EXISTS unsubscribe_actions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        from_address TEXT NOT NULL,
        from_name TEXT,
        method TEXT NOT NULL,
        unsubscribe_url TEXT NOT NULL,
        status TEXT DEFAULT 'subscribed',
        unsubscribed_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, from_address)
      );
      CREATE INDEX idx_unsub_account ON unsubscribe_actions(account_id, status);

      CREATE TABLE IF NOT EXISTS bundle_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        is_bundled INTEGER DEFAULT 1,
        delivery_enabled INTEGER DEFAULT 0,
        delivery_schedule TEXT,
        last_delivered_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, category)
      );
      CREATE INDEX idx_bundle_rules_account ON bundle_rules(account_id);

      CREATE TABLE IF NOT EXISTS bundled_threads (
        account_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        category TEXT NOT NULL,
        held_until INTEGER,
        PRIMARY KEY (account_id, thread_id),
        FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX idx_bundled_held ON bundled_threads(held_until);

      ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT;

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('smart_notifications', 'true'),
        ('notify_categories', 'Primary'),
        ('auto_archive_after_unsubscribe', 'true');
    `,
  },
  {
    version: 7,
    description: 'Send-as aliases',
    sql: `
      CREATE TABLE IF NOT EXISTS send_as_aliases (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        display_name TEXT,
        reply_to_address TEXT,
        signature_id TEXT,
        is_primary INTEGER DEFAULT 0,
        is_default INTEGER DEFAULT 0,
        treat_as_alias INTEGER DEFAULT 1,
        verification_status TEXT DEFAULT 'accepted',
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, email)
      );
      CREATE INDEX idx_send_as_account ON send_as_aliases(account_id);
    `,
  },
  {
    version: 8,
    description: 'Smart folders',
    sql: `
      CREATE TABLE IF NOT EXISTS smart_folders (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        icon TEXT DEFAULT 'Search',
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        is_default INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_smart_folders_account ON smart_folders(account_id);
    `,
  },
  {
    version: 9,
    description: 'Email authentication results',
    sql: `ALTER TABLE messages ADD COLUMN auth_results TEXT;`,
  },
  {
    version: 10,
    description: 'Mute thread support',
    sql: `
      ALTER TABLE threads ADD COLUMN is_muted INTEGER DEFAULT 0;
      CREATE INDEX idx_threads_muted ON threads(account_id, is_muted);
    `,
  },
  {
    version: 11,
    description: 'Phishing detection cache and allowlist',
    sql: `
      CREATE TABLE IF NOT EXISTS link_scan_results (
        message_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        scanned_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS phishing_allowlist (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, sender_address)
      );

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('phishing_detection_enabled', 'true'),
        ('phishing_sensitivity', 'default');
    `,
  },
  {
    version: 12,
    description: 'Quick steps',
    sql: `
      CREATE TABLE IF NOT EXISTS quick_steps (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        shortcut TEXT,
        actions_json TEXT NOT NULL,
        icon TEXT,
        is_enabled INTEGER DEFAULT 1,
        continue_on_error INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX idx_quick_steps_account ON quick_steps(account_id);
    `,
  },
  {
    version: 13,
    description: 'Contact notes',
    sql: `ALTER TABLE contacts ADD COLUMN notes TEXT;`,
  },
  {
    version: 14,
    description: 'IMAP/SMTP provider support',
    sql: `
      ALTER TABLE accounts ADD COLUMN provider TEXT DEFAULT 'gmail_api';
      ALTER TABLE accounts ADD COLUMN imap_host TEXT;
      ALTER TABLE accounts ADD COLUMN imap_port INTEGER;
      ALTER TABLE accounts ADD COLUMN imap_security TEXT;
      ALTER TABLE accounts ADD COLUMN smtp_host TEXT;
      ALTER TABLE accounts ADD COLUMN smtp_port INTEGER;
      ALTER TABLE accounts ADD COLUMN smtp_security TEXT;
      ALTER TABLE accounts ADD COLUMN auth_method TEXT DEFAULT 'oauth';
      ALTER TABLE accounts ADD COLUMN imap_password TEXT;

      ALTER TABLE messages ADD COLUMN message_id_header TEXT;
      ALTER TABLE messages ADD COLUMN references_header TEXT;
      ALTER TABLE messages ADD COLUMN in_reply_to_header TEXT;
      ALTER TABLE messages ADD COLUMN imap_uid INTEGER;
      ALTER TABLE messages ADD COLUMN imap_folder TEXT;

      ALTER TABLE labels ADD COLUMN imap_folder_path TEXT;
      ALTER TABLE labels ADD COLUMN imap_special_use TEXT;

      ALTER TABLE attachments ADD COLUMN imap_part_id TEXT;

      CREATE TABLE IF NOT EXISTS folder_sync_state (
        account_id TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        uidvalidity INTEGER,
        last_uid INTEGER DEFAULT 0,
        modseq INTEGER,
        last_sync_at INTEGER,
        PRIMARY KEY (account_id, folder_path),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_imap_uid ON messages(account_id, imap_folder, imap_uid);
      CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id_header);
    `,
  },
  {
    version: 15,
    description: 'OAuth2 provider support for IMAP/SMTP',
    sql: `
      ALTER TABLE accounts ADD COLUMN oauth_provider TEXT;
      ALTER TABLE accounts ADD COLUMN oauth_client_id TEXT;
      ALTER TABLE accounts ADD COLUMN oauth_client_secret TEXT;
    `,
  },
  {
    version: 16,
    description: 'Optional IMAP/SMTP username override',
    sql: `ALTER TABLE accounts ADD COLUMN imap_username TEXT;`,
  },
  {
    version: 17,
    description: 'Offline mode: pending operations queue and local drafts',
    sql: `
      CREATE TABLE IF NOT EXISTS pending_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        params TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 10,
        next_retry_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON pending_operations(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_pending_ops_resource ON pending_operations(account_id, resource_id);

      CREATE TABLE IF NOT EXISTS local_drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        to_addresses TEXT,
        cc_addresses TEXT,
        bcc_addresses TEXT,
        subject TEXT,
        body_html TEXT,
        reply_to_message_id TEXT,
        thread_id TEXT,
        from_email TEXT,
        signature_id TEXT,
        remote_draft_id TEXT,
        attachments TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        sync_status TEXT DEFAULT 'pending'
      );
    `,
  },
  {
    version: 18,
    description: 'AI auto-drafts writing style profiles and task manager',
    sql: `
      CREATE TABLE IF NOT EXISTS writing_style_profiles (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        profile_text TEXT NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT DEFAULT 'none',
        is_completed INTEGER DEFAULT 0,
        completed_at INTEGER,
        due_date INTEGER,
        parent_id TEXT,
        thread_id TEXT,
        thread_account_id TEXT,
        sort_order INTEGER DEFAULT 0,
        recurrence_rule TEXT,
        next_recurrence_at INTEGER,
        tags_json TEXT DEFAULT '[]',
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_completed_due ON tasks(is_completed, due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_account_id, thread_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(sort_order);

      CREATE TABLE IF NOT EXISTS task_tags (
        tag TEXT NOT NULL,
        account_id TEXT,
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (tag, account_id)
      );

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('ai_auto_draft_enabled', 'true'),
        ('ai_writing_style_enabled', 'true');
    `,
  },
  {
    version: 19,
    description: 'CalDAV calendar integration',
    sql: `
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'google',
        remote_id TEXT NOT NULL,
        display_name TEXT,
        color TEXT,
        is_primary INTEGER DEFAULT 0,
        is_visible INTEGER DEFAULT 1,
        sync_token TEXT,
        ctag TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, remote_id)
      );
      CREATE INDEX IF NOT EXISTS idx_calendars_account ON calendars(account_id);

      ALTER TABLE calendar_events ADD COLUMN calendar_id TEXT REFERENCES calendars(id) ON DELETE CASCADE;
      ALTER TABLE calendar_events ADD COLUMN remote_event_id TEXT;
      ALTER TABLE calendar_events ADD COLUMN etag TEXT;
      ALTER TABLE calendar_events ADD COLUMN ical_data TEXT;
      ALTER TABLE calendar_events ADD COLUMN uid TEXT;

      CREATE INDEX IF NOT EXISTS idx_cal_events_calendar ON calendar_events(calendar_id);

      ALTER TABLE accounts ADD COLUMN caldav_url TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_username TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_password TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_principal_url TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_home_url TEXT;
      ALTER TABLE accounts ADD COLUMN calendar_provider TEXT;
    `,
  },
  {
    version: 20,
    description: 'Clear stale IMAP attachment part IDs (velo upstream repair)',
    sql: `
      DELETE FROM attachments
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');
      DELETE FROM folder_sync_state
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');
    `,
  },
  {
    version: 21,
    description: 'Force IMAP full resync for corrected attachment part IDs (velo upstream repair)',
    sql: `
      UPDATE accounts SET history_id = NULL
        WHERE provider = 'imap';
      DELETE FROM folder_sync_state
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');
      DELETE FROM attachments
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');
    `,
  },
  {
    version: 22,
    description: 'Smart label rules for AI-powered auto-labeling',
    sql: `
      CREATE TABLE smart_label_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL,
        ai_description TEXT NOT NULL,
        criteria_json TEXT,
        is_enabled INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX idx_smart_label_rules_account ON smart_label_rules(account_id);
    `,
  },
  {
    version: 23,
    description: 'Accept self-signed certificates for IMAP/SMTP',
    sql: `ALTER TABLE accounts ADD COLUMN accept_invalid_certs INTEGER DEFAULT 0;`,
  },
  // ---- kylins-client extensions below this line ----
  {
    version: 24,
    description: 'kylins: Plugin state persistence',
    sql: `
      CREATE TABLE IF NOT EXISTS plugin_state (
        id TEXT PRIMARY KEY,
        plugin_path TEXT NOT NULL UNIQUE,
        is_enabled INTEGER DEFAULT 1,
        config TEXT,
        loaded_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_state_enabled ON plugin_state(is_enabled);
    `,
  },
  {
    version: 25,
    description:
      'kylins: ActiveSync sync state — EAS uses sync keys per collection, not IMAP UIDVALIDITY',
    sql: `
      CREATE TABLE IF NOT EXISTS eas_sync_state (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        folder_id TEXT NOT NULL,
        collection_id TEXT,
        sync_key TEXT,
        policy_key TEXT,
        last_sync_at INTEGER,
        PRIMARY KEY (account_id, folder_id)
      );
      CREATE INDEX IF NOT EXISTS idx_eas_sync_account ON eas_sync_state(account_id);
    `,
  },
  {
    version: 26,
    description: 'kylins: ActiveSync account columns',
    sql: `
      ALTER TABLE accounts ADD COLUMN eas_url TEXT;
      ALTER TABLE accounts ADD COLUMN eas_protocol_version TEXT DEFAULT '16.1';
      ALTER TABLE accounts ADD COLUMN eas_device_id TEXT;
      ALTER TABLE accounts ADD COLUMN eas_policy_key TEXT;
      ALTER TABLE accounts ADD COLUMN eas_user_agent TEXT;
    `,
  },
  {
    version: 27,
    description: 'kylins: Default view settings',
    sql: `
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('view.state', '{"readingPanePosition":"right","folderPaneVisible":true,"commandRibbonVisible":true,"statusBarVisible":true,"conversationView":false,"messageListDensity":"normal","visibleColumnIds":["flag","from","subject","received"]}');
    `,
  },
  {
    version: 28,
    description:
      'kylins: Message plugin metadata, calendar recurrence range columns, events full-text search',
    sql: `
      -- Per-message plugin key/value metadata (RSVP state, tracking, …).
      -- Mirrors Mailspring's syncback-metadata pattern. Consumed by
      -- MessageViewExtension / ComposerExtension plugins (Phase 2/4).
      CREATE TABLE IF NOT EXISTS message_metadata (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, message_id, plugin_id),
        FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_message_metadata_message
        ON message_metadata(account_id, message_id);

      -- Calendar recurrence range columns (Mailspring Event.recurrenceStart/End
      -- pattern). Precomputed window used for fast date-range queries over
      -- recurring masters without expanding the RRULE. Populated by the
      -- calendar data layer in Phase 3.
      ALTER TABLE calendar_events ADD COLUMN recurrence_start INTEGER;
      ALTER TABLE calendar_events ADD COLUMN recurrence_end INTEGER;
      CREATE INDEX IF NOT EXISTS idx_cal_events_recurrence
        ON calendar_events(account_id, recurrence_start, recurrence_end);

      -- Full-text search over calendar events (mirrors messages_fts in v2).
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        summary,
        description,
        location,
        content='calendar_events',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON calendar_events BEGIN
        INSERT INTO events_fts(rowid, summary, description, location)
        VALUES (new.rowid, new.summary, new.description, new.location);
      END;

      CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON calendar_events BEGIN
        INSERT INTO events_fts(events_fts, rowid, summary, description, location)
        VALUES ('delete', old.rowid, old.summary, old.description, old.location);
      END;

      CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON calendar_events BEGIN
        INSERT INTO events_fts(events_fts, rowid, summary, description, location)
        VALUES ('delete', old.rowid, old.summary, old.description, old.location);
        INSERT INTO events_fts(rowid, summary, description, location)
        VALUES (new.rowid, new.summary, new.description, new.location);
      END;
    `,
  },
  {
    version: 29,
    description: 'kylins: Signature context (new/reply/forward/all)',
    sql: `
      ALTER TABLE signatures ADD COLUMN context TEXT DEFAULT 'all';
      UPDATE signatures SET context = 'all' WHERE context IS NULL;
      CREATE INDEX IF NOT EXISTS idx_signatures_account_context
        ON signatures(account_id, context);
    `,
  },
  {
    version: 31,
    description: 'kylins: Rich contacts, contact groups, and sync state',
    sql: `
      ALTER TABLE contacts ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
      ALTER TABLE contacts ADD COLUMN source TEXT DEFAULT 'local';
      ALTER TABLE contacts ADD COLUMN external_id TEXT;
      ALTER TABLE contacts ADD COLUMN etag TEXT;
      ALTER TABLE contacts ADD COLUMN raw_vcard TEXT;
      ALTER TABLE contacts ADD COLUMN is_hidden INTEGER DEFAULT 0;
      ALTER TABLE contacts ADD COLUMN is_readonly INTEGER DEFAULT 0;
      ALTER TABLE contacts ADD COLUMN company TEXT;
      ALTER TABLE contacts ADD COLUMN job_title TEXT;
      ALTER TABLE contacts ADD COLUMN emails_json TEXT DEFAULT '[]';
      ALTER TABLE contacts ADD COLUMN phone_numbers_json TEXT DEFAULT '[]';
      ALTER TABLE contacts ADD COLUMN addresses_json TEXT DEFAULT '[]';

      CREATE INDEX IF NOT EXISTS idx_contacts_account_source ON contacts(account_id, source);
      CREATE INDEX IF NOT EXISTS idx_contacts_external ON contacts(account_id, source, external_id);

      CREATE TABLE IF NOT EXISTS contact_groups (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        source TEXT DEFAULT 'local',
        external_id TEXT,
        name TEXT NOT NULL,
        etag TEXT,
        is_readonly INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_contact_groups_account ON contact_groups(account_id);

      CREATE TABLE IF NOT EXISTS contact_group_members (
        group_id TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, contact_id)
      );
      CREATE INDEX IF NOT EXISTS idx_contact_group_members_contact ON contact_group_members(contact_id);

      CREATE TABLE IF NOT EXISTS contact_sync_state (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        sync_token TEXT,
        last_sync_at INTEGER,
        PRIMARY KEY (account_id, source)
      );
    `,
  },
  {
    version: 32,
    description: 'kylins: Seed default preference values for persistent preferences store',
    sql: `
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('launch_on_system_start', 'true'),
        ('show_icon_in_menu_bar', 'true'),
        ('show_gmail_style_important_markers', 'true'),
        ('show_unread_counts_for_all_folders', 'false'),
        ('use_24_hour_clock', 'false'),
        ('interface_language', 'automatic'),
        ('mark_as_read_delay', '0.5'),
        ('automatically_load_images', 'true'),
        ('show_full_message_headers', 'false'),
        ('show_recipient_full_names', 'false'),
        ('restrict_message_width', 'false'),
        ('move_to_trash_on_swipe', 'false'),
        ('disable_swipe_gestures', 'false'),
        ('descending_conversations', 'false'),
        ('message_sent_sound', 'true'),
        ('default_send_behavior', 'send'),
        ('default_reply_behavior', 'reply-all'),
        ('undo_send_duration', '5'),
        ('send_new_messages_from', 'selected-account'),
        ('enable_rich_text', 'true'),
        ('check_spelling', 'true'),
        ('check_grammar', 'false'),
        ('spellcheck_language', 'system'),
        ('show_notifications_for_new_unread', 'true'),
        ('show_notifications_for_repeated_opens', 'true'),
        ('play_sound_on_new_mail', 'true'),
        ('resurface_messages_on_unsnooze', 'true'),
        ('app_icon_badge', 'unread-count'),
        ('open_attachment_folder', 'false'),
        ('display_attachment_thumbnails', 'true'),
        ('cache_auto_cleanup_enabled', 'false'),
        ('share_diagnostics_data', 'false');
    `,
  },
];

/**
 * Split a SQL string into individual statements, correctly handling
 * BEGIN...END blocks (e.g. inside CREATE TRIGGER) that contain semicolons.
 *
 * Limitations: does not handle semicolons inside SQL string literals
 * (e.g. `INSERT INTO t VALUES ('a;b')`) and treats any standalone `BEGIN`
 * as a trigger block (so `BEGIN TRANSACTION` would absorb subsequent
 * statements). None of the current migrations trigger either case; if a
 * future migration needs them, switch to a real SQL parser.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  const upper = sql.toUpperCase();

  for (let i = 0; i < sql.length; i++) {
    if (
      upper.startsWith('BEGIN', i) &&
      (i === 0 || /\W/.test(sql[i - 1]!)) &&
      (i + 5 >= sql.length || /\W/.test(sql[i + 5]!))
    ) {
      depth++;
    }

    if (
      upper.startsWith('END', i) &&
      (i === 0 || /\W/.test(sql[i - 1]!)) &&
      (i + 3 >= sql.length || /\W/.test(sql[i + 3]!)) &&
      depth > 0
    ) {
      depth--;
    }

    if (sql[i] === ';' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
    } else {
      current += sql[i];
    }
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);

  return statements;
}

// Dedupe concurrent callers — e.g. React StrictMode's dev double-mount fires
// init() twice in rapid succession. The first call caches its promise here so
// the second awaits it instead of starting a parallel run. (A previous version
// reset this in a `finally`; that allowed a StrictMode remount to start a fresh
// run after a failure. With manual transactions removed below that re-run is now
// a harmless no-op — v28 is already in `_migrations` and gets skipped — so we
// keep the simple reset-on-completion form.)
let migrationPromise: Promise<void> | null = null;

export function runMigrations(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    try {
      await doRunMigrations();
    } finally {
      migrationPromise = null;
    }
  })();
  return migrationPromise;
}

async function doRunMigrations(): Promise<void> {
  const db = await getDb();

  // Best-effort: make SQLite wait briefly for a lock instead of failing
  // immediately with SQLITE_BUSY (code 5, "database is locked"). The SQL plugin
  // uses a connection pool, so this only configures one pooled connection — the
  // real protection is avoiding transactions that span pooled execute() calls
  // (see the note by the migration loop below).
  await db.execute('PRAGMA busy_timeout = 5000');

  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);

  const applied = await db.select<{ version: number }[]>(
    'SELECT version FROM _migrations ORDER BY version',
  );
  const appliedVersions = new Set(applied.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    console.log(`Running migration v${migration.version}: ${migration.description}`);

    const statements = splitStatements(migration.sql);

    // Each statement is allowed to autocommit — we deliberately do NOT wrap the
    // migration in BEGIN/COMMIT. @tauri-apps/plugin-sql serves every execute()
    // from a pooled connection (see its `Database.close()`: "closes the database
    // connection pool"), so a manual transaction cannot be committed or rolled
    // back on the SAME connection. Issuing BEGIN on one pooled connection and
    // ROLLBACK on another leaks an open write transaction that holds the lock,
    // and the next write — even the next run's BEGIN — then fails immediately
    // with `database is locked`. Migrations are written idempotently (CREATE ...
    // IF NOT EXISTS, duplicate-column tolerance below, INSERT OR IGNORE), so a
    // partially-applied migration resumes cleanly on the next run; the
    // `_migrations` row inserted last marks the migration complete.
    for (const statement of statements) {
      try {
        await db.execute(statement);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('duplicate column')) {
          console.warn(`Skipping duplicate column in v${migration.version}: ${msg}`);
        } else {
          throw err;
        }
      }
    }

    await db.execute('INSERT OR IGNORE INTO _migrations (version, description) VALUES ($1, $2)', [
      migration.version,
      migration.description,
    ]);
  }

  console.log('All migrations applied.');
}
