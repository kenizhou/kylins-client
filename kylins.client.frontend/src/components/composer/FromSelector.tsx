// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.

import type { SendAsAlias } from '@/services/db/sendAsAliases';

interface FromSelectorProps {
  aliases: SendAsAlias[];
  selectedEmail: string;
  onChange: (alias: SendAsAlias) => void;
}

/**
 * Dropdown for selecting a send-as identity. Only rendered when more than one
 * identity is available (the account address plus any aliases).
 */
export function FromSelector({ aliases, selectedEmail, onChange }: FromSelectorProps) {
  if (aliases.length <= 1) return null;

  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-xs text-[var(--muted-foreground)]">From</span>
      <select
        value={selectedEmail}
        onChange={(e) => {
          const alias = aliases.find((a) => a.email === e.target.value);
          if (alias) onChange(alias);
        }}
        className="-ml-1 flex-1 cursor-pointer rounded border-none bg-transparent px-1 py-0.5 text-sm text-[var(--foreground)] outline-none hover:bg-[var(--hover)]"
      >
        {aliases.map((alias) => (
          <option key={alias.id} value={alias.email}>
            {alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}
          </option>
        ))}
      </select>
    </div>
  );
}
