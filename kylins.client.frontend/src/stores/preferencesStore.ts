import { create } from 'zustand';
import { getSetting, setSetting } from '../services/settings';
import { SETTING_KEYS } from '../services/settingsKeys';

export type PreferenceTab =
  | 'General'
  | 'Accounts'
  | 'Appearance'
  | 'Shortcuts'
  | 'Mail Rules'
  | 'Signatures'
  | 'Templates'
  | 'Contacts'
  | 'Security';

interface BoolField {
  key: string;
  defaultValue: boolean;
}

interface StringField {
  key: string;
  defaultValue: string;
}

const BOOL_FIELDS: Record<string, BoolField> = {
  launchOnSystemStart: { key: SETTING_KEYS.launchOnSystemStart, defaultValue: true },
  showIconInMenuBar: { key: SETTING_KEYS.showIconInMenuBar, defaultValue: true },
  showGmailStyleImportantMarkers: {
    key: SETTING_KEYS.showGmailStyleImportantMarkers,
    defaultValue: true,
  },
  showUnreadCountsForAllFolders: {
    key: SETTING_KEYS.showUnreadCountsForAllFolders,
    defaultValue: false,
  },
  use24HourClock: { key: SETTING_KEYS.use24HourClock, defaultValue: false },
  automaticallyLoadImages: { key: SETTING_KEYS.automaticallyLoadImages, defaultValue: true },
  showFullMessageHeaders: { key: SETTING_KEYS.showFullMessageHeaders, defaultValue: false },
  showRecipientFullNames: { key: SETTING_KEYS.showRecipientFullNames, defaultValue: false },
  restrictMessageWidth: { key: SETTING_KEYS.restrictMessageWidth, defaultValue: false },
  moveToTrashOnSwipe: { key: SETTING_KEYS.moveToTrashOnSwipe, defaultValue: false },
  disableSwipeGestures: { key: SETTING_KEYS.disableSwipeGestures, defaultValue: false },
  descendingConversations: { key: SETTING_KEYS.descendingConversations, defaultValue: false },
  messageSentSound: { key: SETTING_KEYS.messageSentSound, defaultValue: true },
  enableRichText: { key: SETTING_KEYS.enableRichText, defaultValue: true },
  checkSpelling: { key: SETTING_KEYS.checkSpelling, defaultValue: true },
  checkGrammar: { key: SETTING_KEYS.checkGrammar, defaultValue: false },
  showNotificationsForNewUnread: {
    key: SETTING_KEYS.showNotificationsForNewUnread,
    defaultValue: true,
  },
  showNotificationsForRepeatedOpens: {
    key: SETTING_KEYS.showNotificationsForRepeatedOpens,
    defaultValue: true,
  },
  doNotDisturb: { key: SETTING_KEYS.doNotDisturb, defaultValue: false },
  playSoundOnNewMail: { key: SETTING_KEYS.playSoundOnNewMail, defaultValue: true },
  resurfaceMessagesOnUnsnooze: {
    key: SETTING_KEYS.resurfaceMessagesOnUnsnooze,
    defaultValue: true,
  },
  openAttachmentFolder: { key: SETTING_KEYS.openAttachmentFolder, defaultValue: false },
  displayAttachmentThumbnails: {
    key: SETTING_KEYS.displayAttachmentThumbnails,
    defaultValue: true,
  },
  cacheAutoCleanupEnabled: { key: SETTING_KEYS.cacheAutoCleanupEnabled, defaultValue: false },
  shareDiagnosticsData: { key: SETTING_KEYS.shareDiagnosticsData, defaultValue: false },
  autoExtractContactsFromMail: {
    key: SETTING_KEYS.autoExtractContactsFromMail,
    defaultValue: true,
  },
  autoExtractContactsFromReceived: {
    key: SETTING_KEYS.autoExtractContactsFromReceived,
    defaultValue: false,
  },
  alwaysShowCcBcc: { key: SETTING_KEYS.alwaysShowCcBcc, defaultValue: false },
};

const STRING_FIELDS: Record<string, StringField> = {
  interfaceLanguage: { key: SETTING_KEYS.interfaceLanguage, defaultValue: 'automatic' },
  markAsReadDelay: { key: SETTING_KEYS.markAsReadDelay, defaultValue: '0.5' },
  defaultSendBehavior: { key: SETTING_KEYS.defaultSendBehavior, defaultValue: 'send' },
  defaultReplyBehavior: { key: SETTING_KEYS.defaultReplyBehavior, defaultValue: 'reply-all' },
  undoSendDuration: { key: SETTING_KEYS.undoSendDuration, defaultValue: '5' },
  sendNewMessagesFrom: { key: SETTING_KEYS.sendNewMessagesFrom, defaultValue: 'selected-account' },
  spellcheckLanguage: { key: SETTING_KEYS.spellcheckLanguage, defaultValue: 'system' },
  appIconBadge: { key: SETTING_KEYS.appIconBadge, defaultValue: 'unread-count' },
};

function persist(key: string, value: string | boolean): void {
  setSetting(key, String(value)).catch((err) => {
    console.error(`Failed to persist preference ${key}:`, err);
  });
}

export interface PreferencesState {
  isOpen: boolean;
  activeTab: PreferenceTab;
  openPreferences: (tab?: PreferenceTab) => void;
  closePreferences: () => void;
  setActiveTab: (tab: PreferenceTab) => void;
  isHydrated: boolean;
  hydrate: () => Promise<void>;

  // General > System / Interface
  launchOnSystemStart: boolean;
  setLaunchOnSystemStart: (value: boolean) => void;
  showIconInMenuBar: boolean;
  setShowIconInMenuBar: (value: boolean) => void;
  showGmailStyleImportantMarkers: boolean;
  setShowGmailStyleImportantMarkers: (value: boolean) => void;
  showUnreadCountsForAllFolders: boolean;
  setShowUnreadCountsForAllFolders: (value: boolean) => void;
  use24HourClock: boolean;
  setUse24HourClock: (value: boolean) => void;
  interfaceLanguage: string;
  setInterfaceLanguage: (value: string) => void;

  // General > Reading
  markAsReadDelay: string;
  setMarkAsReadDelay: (value: string) => void;
  automaticallyLoadImages: boolean;
  setAutomaticallyLoadImages: (value: boolean) => void;
  showFullMessageHeaders: boolean;
  setShowFullMessageHeaders: (value: boolean) => void;
  showRecipientFullNames: boolean;
  setShowRecipientFullNames: (value: boolean) => void;
  restrictMessageWidth: boolean;
  setRestrictMessageWidth: (value: boolean) => void;
  moveToTrashOnSwipe: boolean;
  setMoveToTrashOnSwipe: (value: boolean) => void;
  disableSwipeGestures: boolean;
  setDisableSwipeGestures: (value: boolean) => void;
  descendingConversations: boolean;
  setDescendingConversations: (value: boolean) => void;

  // General > Sending
  messageSentSound: boolean;
  setMessageSentSound: (value: boolean) => void;
  defaultSendBehavior: string;
  setDefaultSendBehavior: (value: string) => void;
  defaultReplyBehavior: string;
  setDefaultReplyBehavior: (value: string) => void;
  undoSendDuration: string;
  setUndoSendDuration: (value: string) => void;
  sendNewMessagesFrom: string;
  setSendNewMessagesFrom: (value: string) => void;

  // Composing
  enableRichText: boolean;
  setEnableRichText: (value: boolean) => void;
  checkSpelling: boolean;
  setCheckSpelling: (value: boolean) => void;
  checkGrammar: boolean;
  setCheckGrammar: (value: boolean) => void;
  spellcheckLanguage: string;
  setSpellcheckLanguage: (value: string) => void;
  alwaysShowCcBcc: boolean;
  setAlwaysShowCcBcc: (value: boolean) => void;

  // Notifications
  showNotificationsForNewUnread: boolean;
  setShowNotificationsForNewUnread: (value: boolean) => void;
  showNotificationsForRepeatedOpens: boolean;
  setShowNotificationsForRepeatedOpens: (value: boolean) => void;
  /**
   * Do Not Disturb: when true, all desktop notifications are suppressed (the
   * in-app unread badge + tray tooltip still update). Surfaced as a toggle in
   * the Notifications preferences panel.
   */
  doNotDisturb: boolean;
  setDoNotDisturb: (value: boolean) => void;
  playSoundOnNewMail: boolean;
  setPlaySoundOnNewMail: (value: boolean) => void;
  resurfaceMessagesOnUnsnooze: boolean;
  setResurfaceMessagesOnUnsnooze: (value: boolean) => void;
  appIconBadge: string;
  setAppIconBadge: (value: string) => void;

  // Attachments / Storage
  openAttachmentFolder: boolean;
  setOpenAttachmentFolder: (value: boolean) => void;
  displayAttachmentThumbnails: boolean;
  setDisplayAttachmentThumbnails: (value: boolean) => void;
  cacheAutoCleanupEnabled: boolean;
  setCacheAutoCleanupEnabled: (value: boolean) => void;

  // Privacy & Security
  shareDiagnosticsData: boolean;
  setShareDiagnosticsData: (value: boolean) => void;

  // Contacts
  autoExtractContactsFromMail: boolean;
  setAutoExtractContactsFromMail: (value: boolean) => void;
  autoExtractContactsFromReceived: boolean;
  setAutoExtractContactsFromReceived: (value: boolean) => void;
}

const defaultState = Object.fromEntries([
  ...Object.entries(BOOL_FIELDS).map(([field, { defaultValue }]) => [field, defaultValue]),
  ...Object.entries(STRING_FIELDS).map(([field, { defaultValue }]) => [field, defaultValue]),
]) as Omit<
  PreferencesState,
  | 'isOpen'
  | 'activeTab'
  | 'openPreferences'
  | 'closePreferences'
  | 'setActiveTab'
  | 'isHydrated'
  | 'hydrate'
  | keyof {
      [K in keyof PreferencesState as PreferencesState[K] extends (...args: unknown[]) => unknown
        ? K
        : never]: K;
    }
>;

export const usePreferencesStore = create<PreferencesState>((set) => ({
  ...defaultState,

  isOpen: false,
  activeTab: 'General',
  isHydrated: false,

  openPreferences: (tab) => set({ isOpen: true, activeTab: tab ?? 'General' }),
  closePreferences: () => set({ isOpen: false }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  hydrate: async () => {
    const boolEntries = await Promise.all(
      Object.entries(BOOL_FIELDS).map(async ([field, { key, defaultValue }]) => {
        const raw = await getSetting(key);
        const value = raw === null ? defaultValue : raw === 'true';
        return [field, value] as const;
      }),
    );

    const stringEntries = await Promise.all(
      Object.entries(STRING_FIELDS).map(async ([field, { key, defaultValue }]) => {
        const raw = await getSetting(key);
        const value = raw ?? defaultValue;
        return [field, value] as const;
      }),
    );

    set({
      ...(Object.fromEntries([...boolEntries, ...stringEntries]) as Partial<PreferencesState>),
      isHydrated: true,
    });
  },

  setLaunchOnSystemStart: (value) => {
    set({ launchOnSystemStart: value });
    persist(SETTING_KEYS.launchOnSystemStart, value);
  },
  setShowIconInMenuBar: (value) => {
    set({ showIconInMenuBar: value });
    persist(SETTING_KEYS.showIconInMenuBar, value);
  },
  setShowGmailStyleImportantMarkers: (value) => {
    set({ showGmailStyleImportantMarkers: value });
    persist(SETTING_KEYS.showGmailStyleImportantMarkers, value);
  },
  setShowUnreadCountsForAllFolders: (value) => {
    set({ showUnreadCountsForAllFolders: value });
    persist(SETTING_KEYS.showUnreadCountsForAllFolders, value);
  },
  setUse24HourClock: (value) => {
    set({ use24HourClock: value });
    persist(SETTING_KEYS.use24HourClock, value);
  },
  setInterfaceLanguage: (value) => {
    set({ interfaceLanguage: value });
    persist(SETTING_KEYS.interfaceLanguage, value);
  },

  setMarkAsReadDelay: (value) => {
    set({ markAsReadDelay: value });
    persist(SETTING_KEYS.markAsReadDelay, value);
  },
  setAutomaticallyLoadImages: (value) => {
    set({ automaticallyLoadImages: value });
    persist(SETTING_KEYS.automaticallyLoadImages, value);
  },
  setShowFullMessageHeaders: (value) => {
    set({ showFullMessageHeaders: value });
    persist(SETTING_KEYS.showFullMessageHeaders, value);
  },
  setShowRecipientFullNames: (value) => {
    set({ showRecipientFullNames: value });
    persist(SETTING_KEYS.showRecipientFullNames, value);
  },
  setRestrictMessageWidth: (value) => {
    set({ restrictMessageWidth: value });
    persist(SETTING_KEYS.restrictMessageWidth, value);
  },
  setMoveToTrashOnSwipe: (value) => {
    set({ moveToTrashOnSwipe: value });
    persist(SETTING_KEYS.moveToTrashOnSwipe, value);
  },
  setDisableSwipeGestures: (value) => {
    set({ disableSwipeGestures: value });
    persist(SETTING_KEYS.disableSwipeGestures, value);
  },
  setDescendingConversations: (value) => {
    set({ descendingConversations: value });
    persist(SETTING_KEYS.descendingConversations, value);
  },

  setMessageSentSound: (value) => {
    set({ messageSentSound: value });
    persist(SETTING_KEYS.messageSentSound, value);
  },
  setDefaultSendBehavior: (value) => {
    set({ defaultSendBehavior: value });
    persist(SETTING_KEYS.defaultSendBehavior, value);
  },
  setDefaultReplyBehavior: (value) => {
    set({ defaultReplyBehavior: value });
    persist(SETTING_KEYS.defaultReplyBehavior, value);
  },
  setUndoSendDuration: (value) => {
    set({ undoSendDuration: value });
    persist(SETTING_KEYS.undoSendDuration, value);
  },
  setSendNewMessagesFrom: (value) => {
    set({ sendNewMessagesFrom: value });
    persist(SETTING_KEYS.sendNewMessagesFrom, value);
  },

  setEnableRichText: (value) => {
    set({ enableRichText: value });
    persist(SETTING_KEYS.enableRichText, value);
  },
  setCheckSpelling: (value) => {
    set({ checkSpelling: value });
    persist(SETTING_KEYS.checkSpelling, value);
  },
  setCheckGrammar: (value) => {
    set({ checkGrammar: value });
    persist(SETTING_KEYS.checkGrammar, value);
  },
  setSpellcheckLanguage: (value) => {
    set({ spellcheckLanguage: value });
    persist(SETTING_KEYS.spellcheckLanguage, value);
  },
  setAlwaysShowCcBcc: (value) => {
    set({ alwaysShowCcBcc: value });
    persist(SETTING_KEYS.alwaysShowCcBcc, value);
  },

  setShowNotificationsForNewUnread: (value) => {
    set({ showNotificationsForNewUnread: value });
    persist(SETTING_KEYS.showNotificationsForNewUnread, value);
  },
  setShowNotificationsForRepeatedOpens: (value) => {
    set({ showNotificationsForRepeatedOpens: value });
    persist(SETTING_KEYS.showNotificationsForRepeatedOpens, value);
  },
  setDoNotDisturb: (value) => {
    set({ doNotDisturb: value });
    persist(SETTING_KEYS.doNotDisturb, value);
  },
  setPlaySoundOnNewMail: (value) => {
    set({ playSoundOnNewMail: value });
    persist(SETTING_KEYS.playSoundOnNewMail, value);
  },
  setResurfaceMessagesOnUnsnooze: (value) => {
    set({ resurfaceMessagesOnUnsnooze: value });
    persist(SETTING_KEYS.resurfaceMessagesOnUnsnooze, value);
  },
  setAppIconBadge: (value) => {
    set({ appIconBadge: value });
    persist(SETTING_KEYS.appIconBadge, value);
  },

  setOpenAttachmentFolder: (value) => {
    set({ openAttachmentFolder: value });
    persist(SETTING_KEYS.openAttachmentFolder, value);
  },
  setDisplayAttachmentThumbnails: (value) => {
    set({ displayAttachmentThumbnails: value });
    persist(SETTING_KEYS.displayAttachmentThumbnails, value);
  },
  setCacheAutoCleanupEnabled: (value) => {
    set({ cacheAutoCleanupEnabled: value });
    persist(SETTING_KEYS.cacheAutoCleanupEnabled, value);
  },

  setShareDiagnosticsData: (value) => {
    set({ shareDiagnosticsData: value });
    persist(SETTING_KEYS.shareDiagnosticsData, value);
  },

  setAutoExtractContactsFromMail: (value) => {
    set({ autoExtractContactsFromMail: value });
    persist(SETTING_KEYS.autoExtractContactsFromMail, value);
  },
  setAutoExtractContactsFromReceived: (value) => {
    set({ autoExtractContactsFromReceived: value });
    persist(SETTING_KEYS.autoExtractContactsFromReceived, value);
  },
}));
