// Task 5 (Option C) cutover: this module no longer touches plugin-sql. Every
// function delegates to a Rust `db_*` Tauri command (see
// `kylins.client.backend/src/db/commands.rs`). Rust owns the `settings` KV
// table; the bool/number convenience wrappers preserve their original TS
// signatures (including the `null`-on-missing semantics).

import { invoke } from '@tauri-apps/api/core';

export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>('db_get_setting', { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  await invoke<void>('db_set_setting', { key, value });
}

export async function getSettingBool(key: string): Promise<boolean | null> {
  return invoke<boolean | null>('db_get_setting_bool', { key });
}

export async function setSettingBool(key: string, value: boolean): Promise<void> {
  await invoke<void>('db_set_setting_bool', { key, value });
}

export async function getSettingNumber(key: string): Promise<number | null> {
  // Rust returns Option<f64>; for our purposes that maps to number | null.
  return invoke<number | null>('db_get_setting_number', { key });
}

export async function setSettingNumber(key: string, value: number): Promise<void> {
  await invoke<void>('db_set_setting_number', { key, value });
}
