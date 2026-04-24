/**
 * Database connection management — SQLite only.
 * Stored at ~/.archon/archon.db.
 */
import { join } from 'path';
import { getArchonHome } from '@archon/paths';
import type { IDatabase, SqlDialect, QueryResult } from './adapters/types';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.connection');
  return cachedLog;
}

let database: IDatabase | null = null;

export function getDatabase(): IDatabase {
  if (database) return database;
  const dbPath = join(getArchonHome(), 'archon.db');
  getLog().info({ dbPath }, 'db.connection_sqlite_selected');
  database = new SqliteAdapter(dbPath);
  return database;
}

export function getDialect(): SqlDialect {
  return sqliteDialect;
}

export function getDatabaseType(): 'sqlite' {
  return 'sqlite';
}

export async function closeDatabase(): Promise<void> {
  if (database) {
    await database.close();
    database = null;
  }
}

export function resetDatabase(): void {
  database = null;
}

export const pool = {
  query: async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
    return getDatabase().query<T>(sql, params);
  },
  end: async (): Promise<void> => {
    await closeDatabase();
  },
};
