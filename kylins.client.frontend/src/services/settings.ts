import { getDb } from './db/connection';

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>('SELECT value FROM settings WHERE key = $1', [
    key,
  ]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)', [key, value]);
}

export async function getSettingBool(key: string): Promise<boolean | null> {
  const raw = await getSetting(key);
  if (raw === null) return null;
  return raw === 'true';
}

export async function setSettingBool(key: string, value: boolean): Promise<void> {
  await setSetting(key, value ? 'true' : 'false');
}

export async function getSettingNumber(key: string): Promise<number | null> {
  const raw = await getSetting(key);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function setSettingNumber(key: string, value: number): Promise<void> {
  await setSetting(key, String(value));
}
