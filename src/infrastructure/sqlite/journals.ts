import type { DatabaseSync } from 'node:sqlite'
import { journalInput } from '../../domain/entry-validation.ts'
import type { JournalRecord } from '../../domain/models.types.d.ts'

import { validDay } from '../../domain/dates.ts'

export function createJournalStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_records (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_journal_day_created ON journal_records(day, createdAt);
  `)

  function checkDay(day: string) {
    if (!validDay(day)) throw new Error('Selecciona una fecha válida.')
  }

  return {
    list: (day: string): JournalRecord[] => {
      checkDay(day)
      return db
        .prepare(
          'SELECT * FROM journal_records WHERE day = ? ORDER BY createdAt DESC, rowid DESC',
        )
        .all(day) as JournalRecord[]
    },
    save: (
      day: string,
      title: unknown,
      body: unknown,
      id?: string,
    ): JournalRecord => {
      checkDay(day)
      const input = journalInput(title, body, 100_000)
      const now = new Date().toISOString()
      if (id) {
        if (
          !db
            .prepare(
              'UPDATE journal_records SET title = ?, body = ?, updatedAt = ? WHERE id = ? AND day = ?',
            )
            .run(input.title, input.body, now, id, day).changes
        )
          throw new Error('El journal no existe en este día.')
      } else {
        id = crypto.randomUUID()
        db.prepare(
          'INSERT INTO journal_records (id, day, title, body, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, day, input.title, input.body, now, now)
      }
      return db
        .prepare('SELECT * FROM journal_records WHERE id = ? AND day = ?')
        .get(id, day) as JournalRecord
    },
    remove: (day: string, id: string) => {
      checkDay(day)
      return (
        db
          .prepare('DELETE FROM journal_records WHERE id = ? AND day = ?')
          .run(id, day).changes > 0
      )
    },
  }
}
