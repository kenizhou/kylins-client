import { usePreferencesStore, type PreferenceTab } from '../../stores/preferencesStore';
import { GeneralPreferences } from './GeneralPreferences';
import { AppearancePreferences } from './AppearancePreferences';
import { ShortcutsPreferences } from './ShortcutsPreferences';
import { AccountsPreferences } from './AccountsPreferences';
import { ContactsPreferences } from './ContactsPreferences';
import { MailPreferences } from './MailPreferences';
import { SecurityPreferences } from './SecurityPreferences';
import { AboutPreferences } from './AboutPreferences';
import { Modal } from '../ui/Modal';
import { Button } from 'react-aria-components';
import { Tabs, TabList, Tab } from 'react-aria-components';
import {
  PreferencesGeneralIcon,
  PreferencesAccountsIcon,
  PreferencesAppearanceIcon,
  PreferencesShortcutsIcon,
  SecurityIcon,
  MailIcon,
  ContactsIcon,
  InfoIcon,
} from '../icons';

const TABS: { id: PreferenceTab; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'General', icon: PreferencesGeneralIcon },
  { id: 'Accounts', icon: PreferencesAccountsIcon },
  { id: 'Appearance', icon: PreferencesAppearanceIcon },
  { id: 'Mail', icon: MailIcon },
  { id: 'Calendar & Contacts', icon: ContactsIcon },
  { id: 'Shortcuts', icon: PreferencesShortcutsIcon },
  { id: 'Security', icon: SecurityIcon },
  { id: 'About', icon: InfoIcon },
];

const TAB_COMPONENTS: Record<PreferenceTab, React.ComponentType> = {
  General: GeneralPreferences,
  Accounts: AccountsPreferences,
  Appearance: AppearancePreferences,
  Mail: MailPreferences,
  'Calendar & Contacts': ContactsPreferences,
  Shortcuts: ShortcutsPreferences,
  Security: SecurityPreferences,
  About: AboutPreferences,
};

export function PreferencesDialog() {
  const isOpen = usePreferencesStore((s) => s.isOpen);
  const activeTab = usePreferencesStore((s) => s.activeTab);
  const setActiveTab = usePreferencesStore((s) => s.setActiveTab);
  const closePreferences = usePreferencesStore((s) => s.closePreferences);

  const TabComponent = TAB_COMPONENTS[activeTab];

  return (
    <Modal
      isOpen={isOpen}
      onClose={closePreferences}
      title="Preferences"
      subtitle="Customize your Kylins experience"
      icon={PreferencesGeneralIcon}
      size="lg"
      disableBackdropClose
      footer={
        <>
          <span className="text-xs text-muted-text">Changes are applied automatically.</span>
          <Button
            onPress={closePreferences}
            className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-fg transition-opacity hover:opacity-90"
          >
            Done
          </Button>
        </>
      }
      contentClassName="!overflow-hidden bg-[color-mix(in_oklab,var(--surface),black_2%)]"
    >
      <Tabs
        orientation="vertical"
        selectedKey={activeTab}
        onSelectionChange={(key) => setActiveTab(key as PreferenceTab)}
        className="flex h-full"
      >
        <TabList
          aria-label="Preferences sections"
          className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-chrome p-3"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <Tab
                key={tab.id}
                id={tab.id}
                className={({ isSelected }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    isSelected
                      ? 'bg-selected text-primary'
                      : 'text-muted-text hover:bg-hover hover:text-foreground'
                  }`
                }
              >
                <Icon size={18} />
                <span>{tab.id}</span>
              </Tab>
            );
          })}
        </TabList>

        <div className="flex-1 overflow-auto kylins-scrollbar">
          {TabComponent && <TabComponent />}
        </div>
      </Tabs>
    </Modal>
  );
}
