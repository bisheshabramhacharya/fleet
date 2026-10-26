import { createRequire } from "node:module";

export interface SqliteDb {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  tables(): Set<string>;
  columns(table: string): Set<string>;
  close(): void;
}

type DatabaseSyncCtor = new (file: string, options: { readOnly: boolean }) => {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
  close(): void;
};

let ctor: DatabaseSyncCtor | null | undefined;

function loadSqlite(): DatabaseSyncCtor | null {
  if (ctor !== undefined) return ctor;
  try {
    // node:sqlite reads WAL databases correctly while their owners keep writing.
    const require = createRequire(import.meta.url ?? __filename);
    ctor = (require("node:sqlite") as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync;
  } catch {
    ctor = null;
  }
  return ctor;
}

/** Opens a SQLite file read-only. Throws when SQLite is unavailable or the file is locked. */
export function openSqlite(file: string): SqliteDb {
  const Database = loadSqlite();
  if (Database === null) throw new Error("This runtime has no built-in SQLite (needs Node 22.13+).");
  const db = new Database(file, { readOnly: true });
  // Fail fast on live-writer locks instead of stalling a scan.
  db.exec("PRAGMA busy_timeout = 200");
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
    tables: () =>
      new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)),
    columns: (table) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)),
    close: () => db.close(),
  };
}

export function withSqlite<T>(file: string, run: (db: SqliteDb) => T): T {
  const db = openSqlite(file);
  try {
    return run(db);
  } finally {
    db.close();
  }
}
