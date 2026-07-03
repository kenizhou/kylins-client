import type { Account } from '@/types';
import { LOCAL_SENTINEL } from '@/components/contacts/constants';
import { ContactsIcon, FolderIcon, UserIcon } from '@/components/icons';

interface ContactAccountPaneProps {
  accounts: Account[];
  selectedAccountId: string | null;
  onSelect: (id: string | null) => void;
}

function AccountRow({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
        active
          ? 'bg-[var(--selected)] text-[var(--selected-text)]'
          : 'text-[var(--foreground)] hover:bg-[var(--hover)]'
      }`}
    >
      <span className="shrink-0 text-[var(--muted-text)]">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

export function ContactAccountPane({
  accounts,
  selectedAccountId,
  onSelect,
}: ContactAccountPaneProps) {
  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto kylins-scrollbar p-2">
      <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted-text)]">
        Accounts
      </div>
      <AccountRow
        label="All accounts"
        active={selectedAccountId === null}
        onClick={() => onSelect(null)}
        icon={<ContactsIcon size={16} />}
      />
      <AccountRow
        label="Local"
        active={selectedAccountId === LOCAL_SENTINEL}
        onClick={() => onSelect(LOCAL_SENTINEL)}
        icon={<FolderIcon size={16} />}
      />
      {accounts.map((account) => {
        const label = account.accountLabel ?? account.email;
        return (
          <AccountRow
            key={account.id}
            label={label}
            active={selectedAccountId === account.id}
            onClick={() => onSelect(account.id)}
            icon={<UserIcon size={16} />}
          />
        );
      })}
    </div>
  );
}
