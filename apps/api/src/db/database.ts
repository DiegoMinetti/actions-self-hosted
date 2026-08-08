import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { env } from '../env.js';

/**
 * Wrapper de `node:sqlite` (built-in en Node 22.5+, estable en Node 26).
 * Más liviano que better-sqlite3 (sin binding nativo) y suficiente para nuestro caso.
 *
 * Si en el futuro queremos migrar a better-sqlite3, cambiamos solo este archivo:
 * el repository expone la misma interfaz.
 */

let _db: DatabaseSync | null = null;

function resolveDbPath(): string {
  if (env.DB_PATH === ':memory:') return ':memory:';
  const path = isAbsolute(env.DB_PATH) ? env.DB_PATH : resolve(process.cwd(), env.DB_PATH);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function getDatabase(): DatabaseSync {
  if (_db) return _db;
  const path = resolveDbPath();
  _db = new DatabaseSync(path);
  // Pragmas básicos: WAL para mejor concurrencia, foreign keys on.
  _db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  console.log(`[db] opened ${path}`);
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Helper para preparar statements cacheados.
 */
export function prepare(sql: string): StatementSync {
  return getDatabase().prepare(sql);
}
