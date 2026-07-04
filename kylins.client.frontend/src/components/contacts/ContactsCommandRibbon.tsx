import { RibbonButton, RibbonGroup } from '@/components/layout/ribbon/RibbonPrimitives';
import { RibbonShell } from '@/components/layout/ribbon/RibbonShell';
import { ContactsIcon, PlusIcon, UploadIcon, DownloadIcon } from '@/components/icons';

interface ContactsCommandRibbonProps {
  onAddContact: () => void;
  onImport: () => void;
  onExport: () => void;
  importing?: boolean;
  exporting?: boolean;
}

export function ContactsCommandRibbon({
  onAddContact,
  onImport,
  onExport,
  importing = false,
  exporting = false,
}: ContactsCommandRibbonProps) {
  return (
    <RibbonShell>
      <RibbonGroup>
        <span className="my-auto flex h-11 items-center gap-2 px-2 text-sm font-semibold text-[var(--text)]">
          <ContactsIcon size={16} />
          Contacts
        </span>
      </RibbonGroup>

      <RibbonGroup>
        <RibbonButton
          primary
          icon={<PlusIcon size={16} />}
          onClick={onAddContact}
          title="Add a new contact"
        >
          New contact
        </RibbonButton>
        <RibbonButton
          icon={<UploadIcon size={16} />}
          onClick={onImport}
          disabled={importing}
          title="Import contacts from a vCard file"
        >
          {importing ? 'Importing…' : 'Import vCard'}
        </RibbonButton>
        <RibbonButton
          icon={<DownloadIcon size={16} />}
          onClick={onExport}
          disabled={exporting}
          title="Export contacts to a vCard file"
        >
          {exporting ? 'Exporting…' : 'Export vCard'}
        </RibbonButton>
      </RibbonGroup>
    </RibbonShell>
  );
}
