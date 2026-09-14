import { randomUUID } from 'node:crypto'
import { moodInput } from '../../domain/entry-validation.ts'
import { checkDay } from '../../domain/validation.ts'
import type { CloudDatabase } from './database.ts'
import { clean, createRecordAccess } from './records.ts'

export function createMoodsRepository(db: CloudDatabase) {
  const { list, remove } = createRecordAccess(db)
  return {
    list: (day: string) => list('mood_records', day),
    add: (day: string, score: unknown, description: unknown = '') => {
      checkDay(day)
      const input = moodInput(score, description)
      const record = {
        id: randomUUID(),
        day,
        score: input.score,
        description: input.description,
        recordedAt: new Date().toISOString(),
        _order: Date.now(),
      }
      return db.run(
        ['mood_records'],
        (t) => {
          t.mood_records.push(record)
          return clean(record)
        },
        { mood_records: [] },
      )
    },
    remove: (day: string, id: string) => remove('mood_records', day, id),
  }
}
