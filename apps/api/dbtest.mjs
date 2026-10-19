// Valida el UPDATE que hace el script de migración, contra una DB real.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('../../data/dbtest.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    volume_name TEXT NOT NULL UNIQUE,
    image TEXT NOT NULL
  );
`);
db.exec(`DELETE FROM runners`);
db.prepare('INSERT INTO runners (id, name, volume_name, image) VALUES (?, ?, ?, ?)').run(
  'id-1',
  'flserver-1',
  'actions-runner-flserver-1-home',
  'actions-runner:2.336.0',
);
db.prepare('INSERT INTO runners (id, name, volume_name, image) VALUES (?, ?, ?, ?)').run(
  'id-2',
  'flserver-2',
  'actions-runner-flserver-2-home',
  'actions-runner:2.336.0',
);

// Esto es exactamente lo que ejecuta el script (con process.argv[1..3]).
const newVol = 'actions-runner-flserver-1-data';
const image = 'actions-self-hosted-runner:2.338.0';
const runnerId = 'id-1';
const r = db
  .prepare('UPDATE runners SET volume_name = ?, image = ? WHERE id = ?')
  .run(newVol, image, runnerId);
console.log('  DB: ' + JSON.stringify(r));

console.log('--- estado final ---');
for (const row of db.prepare('SELECT name, volume_name, image FROM runners ORDER BY name').all()) {
  console.log(`   ${row.name}: volumen=${row.volume_name} imagen=${row.image}`);
}
db.close();
