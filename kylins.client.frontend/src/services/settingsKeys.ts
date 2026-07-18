export const SETTING_KEYS = {
  // General > System / Interface
  launchOnSystemStart: 'launch_on_system_start',
  showIconInMenuBar: 'show_icon_in_menu_bar',
  showGmailStyleImportantMarkers: 'show_gmail_style_important_markers',
  showUnreadCountsForAllFolders: 'show_unread_counts_for_all_folders',
  use24HourClock: 'use_24_hour_clock',
  interfaceLanguage: 'interface_language',

  // General > Reading
  markAsReadDelay: 'mark_as_read_delay',
  automaticallyLoadImages: 'automatically_load_images',
  showFullMessageHeaders: 'show_full_message_headers',
  showRecipientFullNames: 'show_recipient_full_names',
  restrictMessageWidth: 'restrict_message_width',
  moveToTrashOnSwipe: 'move_to_trash_on_swipe',
  disableSwipeGestures: 'disable_swipe_gestures',
  descendingConversations: 'descending_conversations',

  // General > Sending
  messageSentSound: 'message_sent_sound',
  defaultSendBehavior: 'default_send_behavior',
  defaultReplyBehavior: 'default_reply_behavior',
  undoSendDuration: 'undo_send_duration',
  sendNewMessagesFrom: 'send_new_messages_from',

  // Composing
  enableRichText: 'enable_rich_text',
  checkSpelling: 'check_spelling',
  checkGrammar: 'check_grammar',
  spellcheckLanguage: 'spellcheck_language',
  alwaysShowCcBcc: 'always_show_cc_bcc',

  // Notifications
  showNotificationsForNewUnread: 'show_notifications_for_new_unread',
  showNotificationsForRepeatedOpens: 'show_notifications_for_repeated_opens',
  playSoundOnNewMail: 'play_sound_on_new_mail',
  resurfaceMessagesOnUnsnooze: 'resurface_messages_on_unsnooze',
  appIconBadge: 'app_icon_badge',
  // Do Not Disturb: when true, suppress all desktop notifications (still
  // surfaces in-app unread badges + tray tooltip). Stored as a string KV
  // ('true'/'false') to match the rest of the preferences store; no new
  // table.
  doNotDisturb: 'do_not_disturb',

  // Attachments / Storage
  openAttachmentFolder: 'open_attachment_folder',
  displayAttachmentThumbnails: 'display_attachment_thumbnails',
  cacheAutoCleanupEnabled: 'cache_auto_cleanup_enabled',

  // Privacy & Security
  shareDiagnosticsData: 'share_diagnostics_data',

  // Contacts
  autoExtractContactsFromMail: 'auto_extract_contacts_from_mail',
  autoExtractContactsFromReceived: 'auto_extract_contacts_from_received',
  securityIndicatorIcons: 'security_indicator_icons',

  // Appearance
  fontSize: 'font_size',
  serifSubjects: 'serif_subjects',
  reduceMotion: 'reduce_motion',

  // Tools / developer
  installedPluginPaths: 'installed_plugin_paths',
  debugFlags: 'debug_flags',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];
