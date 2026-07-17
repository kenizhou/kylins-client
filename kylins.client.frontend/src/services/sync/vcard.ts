import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { createContact, type Contact, type CreateContactInput } from '../db/contacts';

export interface VCardContact {
  id?: string;
  email?: string;
  displayName?: string;
  company?: string;
  jobTitle?: string;
  emails: { label?: string; value: string; isPrimary?: boolean }[];
  phones: { label?: string; value: string }[];
  addresses: {
    label?: string;
    formatted?: string;
    street?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  }[];
  notes?: string;
  avatarUrl?: string;
  rawVcard?: string;
}

function toCreateInput(parsed: VCardContact): CreateContactInput {
  const primaryEmail =
    parsed.emails.find((e) => e.isPrimary)?.value ?? parsed.emails[0]?.value ?? parsed.email ?? '';
  return {
    email: primaryEmail,
    displayName: parsed.displayName ?? null,
    source: 'local',
    externalId: parsed.id ?? null,
    rawVCard: parsed.rawVcard ?? null,
    avatarUrl: parsed.avatarUrl ?? null,
    company: parsed.company ?? null,
    jobTitle: parsed.jobTitle ?? null,
    emails: parsed.emails,
    phones: parsed.phones,
    addresses: parsed.addresses,
    notes: parsed.notes ?? null,
  };
}

export async function importVCard(): Promise<number> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: 'vCard', extensions: ['vcf', 'vcard'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!path || Array.isArray(path)) return 0;

  const data = await invoke<string>('read_text_file', { path });
  const parsed = await invoke<VCardContact[]>('parse_vcard', { data });

  for (const contact of parsed) {
    await createContact(toCreateInput(contact));
  }
  return parsed.length;
}

export async function exportVCard(contacts: Contact[]): Promise<string | null> {
  const path = await save({
    filters: [{ name: 'vCard', extensions: ['vcf'] }],
    defaultPath: 'contacts.vcf',
  });
  if (!path) return null;

  const payload = contacts.map((c) => ({
    id: c.id,
    email: c.email,
    displayName: c.displayName ?? undefined,
    company: c.company ?? undefined,
    jobTitle: c.jobTitle ?? undefined,
    emails: c.emails,
    phones: c.phones,
    addresses: c.addresses,
    notes: c.notes ?? undefined,
    avatarUrl: c.avatarUrl ?? undefined,
    rawVcard: c.rawVCard ?? undefined,
  }));

  const data = await invoke<string>('export_vcard', { contacts: payload });
  await invoke('write_text_file', { path, data });
  return path;
}
