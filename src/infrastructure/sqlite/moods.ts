import type { DatabaseSync } from 'node:sqlite'
import { moodInput } from '../../domain/entry-validation.ts'
import type { MoodRecord } from '../../domain/models.types.d.ts'

import { validDay } from '../../domain/dates.ts'

export function createMoodStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mood_records (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      score INTEGER NOT NULL CHECK (typeof(score) = 'integer' AND score BETWEEN 0 AND 10),
      recordedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mood_day_time ON mood_records(day, recordedAt);
  `)

  const columns = db.prepare('PRAGMA table_info(mood_records)').all()
  if (!columns.some((column) => column.name === 'description')) {
    db.exec(
      "ALTER TABLE mood_records ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    )
  }

  function checkDay(day: string) {
    if (!validDay(day)) throw new Error('Selecciona una fecha válida.')
  }

  return {
    list: (day: string): MoodRecord[] => {
      checkDay(day)
      return db
        .prepare(
          'SELECT * FROM mood_records WHERE day = ? ORDER BY recordedAt DESC, rowid DESC',
        )
        .all(day) as MoodRecord[]
    },
    add: (
      day: string,
      score: unknown,
      description: unknown = '',
    ): MoodRecord => {
      checkDay(day)
      const input = moodInput(score, description)
      const record = {
        id: crypto.randomUUID(),
        day,
        score: input.score,
        description: input.description,
        recordedAt: new Date().toISOString(),
      }
      db.prepare(
        'INSERT INTO mood_records (id, day, score, recordedAt, description) VALUES (?, ?, ?, ?, ?)',
      ).run(record.id, day, input.score, record.recordedAt, record.description)
      return record
    },
    remove: (day: string, id: string) => {
      checkDay(day)
      return (
        db
          .prepare('DELETE FROM mood_records WHERE day = ? AND id = ?')
          .run(day, id).changes > 0
      )
    },
  }
}
