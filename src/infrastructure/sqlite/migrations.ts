import type { DatabaseSync } from 'node:sqlite'

export function migrateFactorScale(db: DatabaseSync) {
  // Convert persisted factors once, including archived template versions.
  // Keeping both updates in one transaction prevents mixed scales after a failure.
  db.exec('BEGIN IMMEDIATE')
  try {
    const name = 'quality-factors-0-to-10'
    if (!db.prepare('SELECT name FROM migrations WHERE name = ?').get(name)) {
      db.exec(`
        UPDATE tasks
        SET importance = importance * 10,
            depth = depth * 10,
            impact = impact * 10;
        UPDATE template_versions
        SET content = json_set(
          content,
          '$.importance', json_extract(content, '$.importance') * 10,
          '$.depth', json_extract(content, '$.depth') * 10,
          '$.impact', json_extract(content, '$.impact') * 10
        );
      `)
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(name)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
