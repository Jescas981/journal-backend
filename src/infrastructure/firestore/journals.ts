import { randomUUID } from 'node:crypto'
import { journalInput } from '../../domain/entry-validation.ts'
import { checkDay } from '../../domain/validation.ts'
import type { CloudDatabase } from './database.ts'
import { clean, createRecordAccess } from './records.ts'

export function createJournalsRepository(db: CloudDatabase) {
  const { list, remove } = createRecordAccess(db)
  return {
    list: (day: string) => list('journal_records', day),
    save: (day: string, title: unknown, body: unknown, id?: string) => {
      checkDay(day)
      const input = journalInput(title, body, 20_000)
      return db.run(['journal_records'], (t) => {
        const old = id
          ? t.journal_records.find((r) => r.id === id && r.day === day)
          : undefined
        if (id && !old) throw new Error('El journal no existe en este día.')
        const now = new Date().toISOString()
        const record = {
          ...old,
          id: id ?? randomUUID(),
          day,
          title: input.title,
          body: input.body,
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
          _order: old?._order ?? Date.now(),
        }
        t.journal_records = t.journal_records.filter((r) => r.id !== record.id)
        t.journal_records.push(record)
        return clean(record)
      })
    },
    remove: (day: string, id: string) => remove('journal_records', day, id),
  }
}
