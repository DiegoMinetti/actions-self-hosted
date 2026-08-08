import { getDatabase } from './database.js';

/**
 * Sistema de migraciones simple: una tabla `migrations` con el nombre de las
 * migraciones ya aplicadas. Cada migración es idempotente y corre en orden.
 *
 * Sprint 1: 001_initial (runners + runner_events).
 */

const MIGRATIONS: Array<{ id: string; up: (sql: (q: string) => void) => void }> = [
  {
    id: '001_initial',
    up: (sql) => {
      sql(`
        CREATE TABLE IF NOT EXISTS runners (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          scope TEXT NOT NULL CHECK (scope IN ('repo', 'org')),
          target TEXT NOT NULL,
          target_slug TEXT NOT NULL,
          labels TEXT NOT NULL DEFAULT '[]',
          image TEXT NOT NULL DEFAULT 'ghcr.io/actions/actions-runner:latest',
          container_name TEXT NOT NULL UNIQUE,
          volume_name TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'creating',
          container_state TEXT NOT NULL DEFAULT 'unknown',
          last_error TEXT,
          runner_group TEXT NOT NULL DEFAULT 'Default',
          restart_policy TEXT NOT NULL DEFAULT 'unless-stopped',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_seen_at TEXT
        );
      `);

      sql(`
        CREATE TABLE IF NOT EXISTS runner_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          runner_id TEXT NOT NULL,
          type TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
        );
      `);

      sql(`CREATE INDEX IF NOT EXISTS idx_runners_status ON runners(status);`);
      sql(`CREATE INDEX IF NOT EXISTS idx_runner_events_runner_id ON runner_events(runner_id);`);
      sql(`CREATE INDEX IF NOT EXISTS idx_runner_events_created_at ON runner_events(created_at);`);
    },
  },
  {
    // Sprint 3: GitHub PATs (multi-cuenta, encriptados en DB).
    // `encrypted_token` es AES-256-GCM con la master key de APP_ENCRYPTION_KEY.
    // `owner_login` matchea el slug del owner para runners de repo;
    // `org_login` matchea el slug de la org para runners de org.
    // `github_runner_id` se setea después de la primera sync con la API
    // de GitHub; lo necesitamos para consultar busy/idle.
    id: '002_github_pats',
    up: (sql) => {
      sql(`
        CREATE TABLE IF NOT EXISTS github_pats (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          encrypted_token TEXT NOT NULL,
          token_last4 TEXT NOT NULL,
          is_personal INTEGER NOT NULL DEFAULT 0,
          owner_login TEXT,
          org_login TEXT,
          github_user_login TEXT,
          scopes TEXT,
          last_used_at TEXT,
          last_tested_at TEXT,
          last_test_ok INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // Columnas nuevas en runners
      sql(
        `ALTER TABLE runners ADD COLUMN github_pat_id TEXT REFERENCES github_pats(id) ON DELETE SET NULL;`,
      );
      sql(`ALTER TABLE runners ADD COLUMN github_runner_id TEXT;`);
      sql(`ALTER TABLE runners ADD COLUMN github_status TEXT NOT NULL DEFAULT 'unknown';`);
      sql(`ALTER TABLE runners ADD COLUMN github_status_checked_at TEXT;`);

      sql(`CREATE INDEX IF NOT EXISTS idx_runners_github_pat_id ON runners(github_pat_id);`);
    },
  },
];

export function runMigrations(): void {
  const db = getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT id FROM migrations')
      .all()
      .map((row: unknown) => (row as { id: string }).id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      console.log(`[db] migration ${migration.id} already applied`);
      continue;
    }
    console.log(`[db] applying migration ${migration.id}...`);
    const tx = db.exec.bind(db);
    migration.up((q) => tx(q));
    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
      migration.id,
      new Date().toISOString(),
    );
    console.log(`[db] migration ${migration.id} applied`);
  }
}
