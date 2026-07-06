// CRUD over the `calendars` table. Mirrors the backend `db::calendars` module.

import { invoke } from '@tauri-apps/api/core';

export interface DbCalendar {
  id: string;
  accountId: string;
  provider: string;
  remoteId: string;
  displayName: string | null;
  color: string | null;
  isPrimary: boolean;
  isVisible: boolean;
  syncToken: string | null;
  ctag: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertCalendarInput {
  id?: string;
  accountId?: string;
  provider?: string;
  remoteId?: string;
  displayName?: string | null;
  color?: string | null;
  isPrimary?: boolean;
  isVisible?: boolean;
  syncToken?: string | null;
  ctag?: string | null;
}

export async function getAllCalendars(): Promise<DbCalendar[]> {
  return invoke<DbCalendar[]>('db_get_all_calendars');
}

export async function getCalendarsForAccount(accountId: string): Promise<DbCalendar[]> {
  return invoke<DbCalendar[]>('db_get_calendars_for_account', { accountId });
}

export async function getCalendarById(id: string): Promise<DbCalendar | null> {
  return invoke<DbCalendar | null>('db_get_calendar_by_id', { id });
}

export async function createCalendar(input: UpsertCalendarInput): Promise<DbCalendar> {
  return invoke<DbCalendar>('db_create_calendar', { input });
}

export async function updateCalendar(id: string, updates: UpsertCalendarInput): Promise<void> {
  await invoke<void>('db_update_calendar', { id, updates });
}

export async function deleteCalendar(id: string): Promise<void> {
  await invoke<void>('db_delete_calendar', { id });
}

export async function setCalendarVisible(id: string, visible: boolean): Promise<void> {
  await invoke<void>('db_set_calendar_visible', { id, visible });
}

export async function setPrimaryCalendar(id: string, accountId: string): Promise<void> {
  await invoke<void>('db_set_primary_calendar', { id, accountId });
}
