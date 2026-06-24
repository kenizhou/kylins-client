import Database from '@tauri-apps/plugin-sql';

let db: Database | null = null;
let pending: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;
  if (pending) return pending;

  pending = (async () => {
    try {
      const instance = await Database.load('sqlite:mailclient.db');
      db = instance;
      return instance;
    } finally {
      pending = null;
    }
  })();

  return pending;
}

let txQueue: Promise<void> = Promise.resolve();

export async function withTransaction(fn: (db: Database) => Promise<void>): Promise<void> {
  const prev = txQueue;
  let resolve!: () => void;
  txQueue = new Promise<void>((r) => {
    resolve = r;
  });
  try {
    await prev;
  } catch {
    // ignore previous errors
  }
  const database = await getDb();
  try {
    await database.execute('BEGIN TRANSACTION', []);
    try {
      await fn(database);
      await database.execute('COMMIT', []);
    } catch (err) {
      try {
        await database.execute('ROLLBACK', []);
      } catch {
        // already rolled back
      }
      throw err;
    }
  } finally {
    resolve();
  }
}

// ---- Query helpers (ported from velo's connection.ts) ----

/** Coerce a boolean to SQLite's 0/1 integer. */
export function boolToInt(b: boolean): number {
  return b ? 1 : 0;
}

/** Run a SELECT and return the first row, or null. */
export async function selectFirstBy<T>(sql: string, params: unknown[] = []): Promise<T | null> {
  const db = await getDb();
  const rows = await db.select<T[]>(sql, params);
  return rows[0] ?? null;
}

/** Build a dynamic `UPDATE table SET ... WHERE idColumn = idValue` from field tuples. */
export function buildDynamicUpdate(
  table: string,
  idColumn: string,
  idValue: unknown,
  fields: [string, unknown][],
): { sql: string; params: unknown[] } | null {
  if (fields.length === 0) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  for (const [column, value] of fields) {
    sets.push(`${column} = $${idx++}`);
    params.push(value);
  }
  params.push(idValue);
  const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${idColumn} = $${idx}`;
  return { sql, params };
}
