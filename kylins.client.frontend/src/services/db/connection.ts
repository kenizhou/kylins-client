import Database from '@tauri-apps/plugin-sql';

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load('sqlite:mailclient.db');
  }
  return db;
}

let txQueue: Promise<void> = Promise.resolve();

export async function withTransaction(
  fn: (db: Database) => Promise<void>,
): Promise<void> {
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
