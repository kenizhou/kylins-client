// Ported from velo (https://github.com/avihaymenahem/velo) — Apache-2.0.
// See ATTRIBUTIONS.md. Adapted for Kylins Client.

import type { SendAsAlias } from '@/services/db/sendAsAliases';
import {
  Select,
  Label,
  Button,
  Popover,
  ListBox,
  ListBoxItem,
  SelectValue,
} from 'react-aria-components';

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
    <Select
      selectedKey={selectedEmail}
      onSelectionChange={(key) => {
        const alias = aliases.find((a) => a.email === String(key));
        if (alias) onChange(alias);
      }}
      className="flex items-center gap-2"
    >
      <Label className="w-8 shrink-0 pt-1.5 text-xs font-medium text-muted-text">From</Label>
      <Button className="-ml-1 flex-1 cursor-pointer rounded border-none bg-transparent px-1 py-0.5 text-left text-sm text-foreground outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
        <SelectValue />
      </Button>
      <Popover className="min-w-[--trigger-width] rounded border border-border bg-popover shadow-lg">
        <ListBox className="py-1 outline-none">
          {aliases.map((alias) => (
            <ListBoxItem
              key={alias.id}
              id={alias.email}
              className="cursor-pointer px-3 py-2 text-sm text-foreground hover:bg-hover selected:bg-selected selected:text-selected-text focus-visible:outline-none"
            >
              {alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
