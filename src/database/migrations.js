// Миграции схемы: SQL-файлы из prisma/migrations применяются по порядку, каждый один раз.
// Применённые записываются в служебную таблицу _app_migrations.
// Работает синхронно и до подключения Prisma — чтобы к старту приложения схема уже была актуальной.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', '..', 'prisma', 'migrations');

function runMigrations(databasePath) {
  const connection = new Database(databasePath);
  try {
    connection.exec('CREATE TABLE IF NOT EXISTS _app_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
    const appliedNames = new Set(connection.prepare('SELECT name FROM _app_migrations').all().map((migration) => migration.name));
    const migrationFiles = fs.readdirSync(MIGRATIONS_DIRECTORY).filter((fileName) => fileName.endsWith('.sql')).sort();
    for (const fileName of migrationFiles) {
      if (appliedNames.has(fileName)) continue;
      const migrationSql = fs.readFileSync(path.join(MIGRATIONS_DIRECTORY, fileName), 'utf8');
      connection.transaction(() => {
        connection.exec(migrationSql);
        connection.prepare('INSERT INTO _app_migrations (name) VALUES (?)').run(fileName);
      })();
      console.log(`База: применена миграция ${fileName}`);
    }
  } finally {
    connection.close();
  }
}

module.exports = { runMigrations };
