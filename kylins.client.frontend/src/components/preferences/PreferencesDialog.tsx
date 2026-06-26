import { usePreferencesStore, type PreferenceTab } from '../../stores/preferencesStore';
import { GeneralPreferences } from './GeneralPreferences';
import { AppearancePreferences } from './AppearancePreferences';
import { ShortcutsPreferences } from './ShortcutsPreferences';
import { SignaturesPreferences } from './SignaturesPreferences';
import { AccountsPreferences } from './AccountsPreferences';
import { ContactsPreferences } from './ContactsPreferences';
import { SecurityPreferences } from './SecurityPreferences';
import { Modal } from '../ui/Modal';
import {
  PreferencesGeneralIcon,
  PreferencesAccountsIcon,
  PreferencesAppearanceIcon,
  PreferencesShortcutsIcon,
  PreferencesMailRulesIcon,
  PreferencesSignaturesIcon,
  PreferencesTemplatesIcon,
  ContactsIcon,
  PreferencesPrivacySecurityIcon,
} from '../icons';

const TABS: { id: PreferenceTab; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'General', icon: PreferencesGeneralIcon },
  { id: 'Accounts', icon: PreferencesAccountsIcon },
  { id: 'Appearance', icon: PreferencesAppearanceIcon },
  { id: 'Shortcuts', icon: PreferencesShortcutsIcon },
  { id: 'Mail Rules', icon: PreferencesMailRulesIcon },
  { id: 'Signatures', icon: PreferencesSignaturesIcon },
  { id: 'Templates', icon: PreferencesTemplatesIcon },
  { id: 'Contacts', icon: ContactsIcon },
  { id: 'Security', icon: PreferencesPrivacySecurityIcon },
];

const TAB_COMPONENTS: Record<string, React.ComponentType> = {
  General: GeneralPreferences,
  Accounts: AccountsPreferences,
  Appearance: AppearancePreferences,
  Shortcuts: ShortcutsPreferences,
  Signatures: SignaturesPreferences,
  Contacts: ContactsPreferences,
  Security: SecurityPreferences,
};

function ComingSoonTab({ tab }: { tab: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-[var(--muted-text)]">
      <span className="text-4xl opacity-40">🚧</span>
      <p className="text-sm">{tab} preferences are coming soon.</p>
    </div>
  );
}

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
          <span className="text-xs text-[var(--muted-text)]">
            Changes are applied automatically.
          </span>
          <button
            type="button"
            onClick={closePreferences}
            className="px-5 py-2 text-sm font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-fg)] hover:opacity-90 transition-opacity"
          >
            Done
          </button>
        </>
      }
      contentClassName="!overflow-hidden bg-[color-mix(in_oklab,var(--surface),black_2%)]"
    >
      <div className="flex h-full">
        {/* Tabs */}
        <div className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-[var(--border)] bg-[var(--chrome)] p-3 overflow-y-auto">
          {TABS.map((tab) => {
            const active = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[var(--selected)] text-[var(--primary)]'
                    : 'text-[var(--muted-text)] hover:bg-[var(--hover)] hover:text-[var(--foreground)]'
                }`}
              >
                <Icon size={18} />
                <span>{tab.id}</span>
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-auto kylins-scrollbar">
          {TabComponent ? <TabComponent /> : <ComingSoonTab tab={activeTab} />}
        </div>
      </div>
    </Modal>
  );
}
