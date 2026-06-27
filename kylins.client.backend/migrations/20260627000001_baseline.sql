-- Baseline schema for Kylins Client. Idempotent: safe to apply on top of a DB
-- already populated by the legacy frontend migrations (versions 1-36).
-- This file consolidates every table in its final end-state (all ALTERs from
-- v1-v36 folded into the CREATE TABLE). All statements use IF NOT EXISTS so
-- re-applying on a DB that already has any of these objects is a no-op.
--
-- Note on semicolons inside SQL comments: the legacy frontend migration runner
-- used a naive statement splitter; sqlx uses a real parser and is unaffected.
-- We keep -- comments semicolon-free to match the project's house style.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- Internal migration bookkeeping (legacy). Kept for compatibility with the
-- frontend's runMigrations(); sqlx manages its own _sqlx_migrations table.
CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  description TEXT,
  applied_at INTEGER DEFAULT (unixepoch())
);

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
  updated_at INTEGER DEFAULT (unixepoch()),
  provider TEXT DEFAULT 'gmail_api',
  imap_host TEXT,
  imap_port INTEGER,
  imap_security TEXT,
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_security TEXT,
  auth_method TEXT DEFAULT 'oauth',
  imap_password TEXT,
  oauth_provider TEXT,
  oauth_client_id TEXT,
  oauth_client_secret TEXT,
  imap_username TEXT,
  caldav_url TEXT,
  caldav_username TEXT,
  caldav_password TEXT,
  caldav_principal_url TEXT,
  caldav_home_url TEXT,
  calendar_provider TEXT,
  accept_invalid_certs INTEGER DEFAULT 0,
  eas_url TEXT,
  eas_protocol_version TEXT DEFAULT '16.1',
  eas_device_id TEXT,
  eas_policy_key TEXT,
  eas_user_agent TEXT,
  account_label TEXT,
  setup_provider_id TEXT,
  is_default INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  color_bg TEXT,
  color_fg TEXT,
  visible INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  imap_folder_path TEXT,
  imap_special_use TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  role TEXT,
  parent_id TEXT,
  remote_id TEXT,
  delimiter TEXT,
  mail_class TEXT NOT NULL DEFAULT 'mail',
  unread_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  hierarchical_name TEXT,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_labels_account ON labels(account_id);
CREATE INDEX IF NOT EXISTS idx_labels_role ON labels(account_id, role);
CREATE INDEX IF NOT EXISTS idx_labels_parent ON labels(account_id, parent_id);

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
  from_address TEXT,
  from_name TEXT,
  snooze_until INTEGER,
  is_pinned INTEGER DEFAULT 0,
  is_muted INTEGER DEFAULT 0,
  classification_id TEXT,
  is_encrypted INTEGER DEFAULT 0,
  is_signed INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_threads_cursor ON threads(account_id, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_snoozed ON threads(account_id, is_snoozed);
CREATE INDEX IF NOT EXISTS idx_threads_pinned ON threads(account_id, is_pinned);
CREATE INDEX IF NOT EXISTS idx_threads_muted ON threads(account_id, is_muted);

CREATE TABLE IF NOT EXISTS thread_labels (
  thread_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (account_id, thread_id, label_id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_thread_labels_label ON thread_labels(account_id, label_id);

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
  list_unsubscribe TEXT,
  list_unsubscribe_post TEXT,
  auth_results TEXT,
  message_id_header TEXT,
  references_header TEXT,
  in_reply_to_header TEXT,
  imap_uid INTEGER,
  imap_folder TEXT,
  classification_id TEXT,
  is_encrypted INTEGER DEFAULT 0,
  is_signed INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(account_id, date);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(account_id, from_address);
CREATE INDEX IF NOT EXISTS idx_messages_imap_uid ON messages(account_id, imap_folder, imap_uid);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id_header);

CREATE TABLE IF NOT EXISTS message_bodies (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  body_html TEXT,
  fetched_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, message_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);

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
  cached_at INTEGER,
  cache_size INTEGER,
  imap_part_id TEXT,
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(account_id, message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_cid ON attachments(content_id);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  frequency INTEGER DEFAULT 1,
  last_contacted_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  first_contacted_at INTEGER,
  notes TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT DEFAULT 'local',
  external_id TEXT,
  etag TEXT,
  raw_vcard TEXT,
  is_hidden INTEGER DEFAULT 0,
  is_readonly INTEGER DEFAULT 0,
  company TEXT,
  job_title TEXT,
  emails_json TEXT DEFAULT '[]',
  phone_numbers_json TEXT DEFAULT '[]',
  addresses_json TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_frequency ON contacts(frequency DESC);
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

CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body_html TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  context TEXT DEFAULT 'all'
);
CREATE INDEX IF NOT EXISTS idx_signatures_account_context ON signatures(account_id, context);

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

CREATE TABLE IF NOT EXISTS ai_cache (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(account_id, thread_id, type)
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_lookup ON ai_cache(account_id, thread_id, type);

CREATE TABLE IF NOT EXISTS thread_categories (
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  category TEXT NOT NULL,
  is_manual INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, thread_id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_thread_categories_cat ON thread_categories(account_id, category);

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

CREATE TABLE IF NOT EXISTS calendar_events (
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
  calendar_id TEXT REFERENCES calendars(id) ON DELETE CASCADE,
  remote_event_id TEXT,
  etag TEXT,
  ical_data TEXT,
  uid TEXT,
  recurrence_start INTEGER,
  recurrence_end INTEGER,
  UNIQUE(account_id, google_event_id)
);
CREATE INDEX IF NOT EXISTS idx_cal_events_time ON calendar_events(account_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_cal_events_calendar ON calendar_events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_cal_events_recurrence ON calendar_events(account_id, recurrence_start, recurrence_end);

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
CREATE INDEX IF NOT EXISTS idx_followup_status ON follow_up_reminders(status, remind_at);
CREATE INDEX IF NOT EXISTS idx_followup_thread ON follow_up_reminders(account_id, thread_id);

CREATE TABLE IF NOT EXISTS notification_vips (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(account_id, email_address)
);
CREATE INDEX IF NOT EXISTS idx_notification_vips ON notification_vips(account_id, email_address);

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
CREATE INDEX IF NOT EXISTS idx_unsub_account ON unsubscribe_actions(account_id, status);

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
CREATE INDEX IF NOT EXISTS idx_bundle_rules_account ON bundle_rules(account_id);

CREATE TABLE IF NOT EXISTS bundled_threads (
  account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  category TEXT NOT NULL,
  held_until INTEGER,
  PRIMARY KEY (account_id, thread_id),
  FOREIGN KEY (account_id, thread_id) REFERENCES threads(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bundled_held ON bundled_threads(held_until);

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
CREATE INDEX IF NOT EXISTS idx_send_as_account ON send_as_aliases(account_id);

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
CREATE INDEX IF NOT EXISTS idx_smart_folders_account ON smart_folders(account_id);

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
CREATE INDEX IF NOT EXISTS idx_quick_steps_account ON quick_steps(account_id);

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

CREATE TABLE IF NOT EXISTS smart_label_rules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL,
  ai_description TEXT NOT NULL,
  criteria_json TEXT,
  is_enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_smart_label_rules_account ON smart_label_rules(account_id);

CREATE TABLE IF NOT EXISTS plugin_state (
  id TEXT PRIMARY KEY,
  plugin_path TEXT NOT NULL UNIQUE,
  is_enabled INTEGER DEFAULT 1,
  config TEXT,
  loaded_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_plugin_state_enabled ON plugin_state(is_enabled);

CREATE TABLE IF NOT EXISTS message_metadata (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, message_id, plugin_id),
  FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_metadata_message ON message_metadata(account_id, message_id);

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

CREATE TABLE IF NOT EXISTS folder_sync_state (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL,
  uidvalidity INTEGER,
  last_uid INTEGER DEFAULT 0,
  modseq INTEGER,
  last_sync_at INTEGER,
  PRIMARY KEY (account_id, folder_path)
);

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
  sync_status TEXT DEFAULT 'pending',
  classification_id TEXT,
  is_encrypted INTEGER DEFAULT 0,
  is_signed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed default settings. Idempotent via INSERT OR IGNORE. These are the union
-- of all seeds scattered across the legacy migrations (v1, v4, v5, v6, v11,
-- v18, v27, v32). Re-running on a populated DB is a no-op.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('theme', 'system'),
  ('sidebar_collapsed', 'false'),
  ('reading_pane_position', 'right'),
  ('sync_period_days', '365'),
  ('notifications_enabled', 'true'),
  ('undo_send_delay_seconds', '5'),
  ('default_font', 'system'),
  ('font_size', 'default'),
  ('block_remote_images', 'true'),
  ('ai_enabled', 'true'),
  ('ai_auto_categorize', 'true'),
  ('ai_auto_summarize', 'true'),
  ('contact_sidebar_visible', 'true'),
  ('attachment_cache_max_mb', '500'),
  ('calendar_enabled', 'false'),
  ('smart_notifications', 'true'),
  ('notify_categories', 'Primary'),
  ('auto_archive_after_unsubscribe', 'true'),
  ('phishing_detection_enabled', 'true'),
  ('phishing_sensitivity', 'default'),
  ('ai_auto_draft_enabled', 'true'),
  ('ai_writing_style_enabled', 'true'),
  ('view.state', '{"readingPanePosition":"right","folderPaneVisible":true,"commandRibbonVisible":true,"statusBarVisible":true,"conversationView":false,"messageListDensity":"normal","visibleColumnIds":["flag","from","subject","received"]}'),
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

-- Full-text search over messages (legacy v2). External-content table + 3
-- triggers copied verbatim. tokenize='trigram' supports substring search.
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

-- Full-text search over calendar events (legacy v28). Same external-content
-- pattern as messages_fts.
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
