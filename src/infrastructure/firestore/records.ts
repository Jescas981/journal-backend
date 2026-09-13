import { checkDay } from '../../domain/validation.ts'
import type { CloudDatabase, Row } from './database.ts'

export const clean = (row: Row) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => !key.startsWith('_') && key !== 'storagePath',
    ),
  )

export function createRecordAccess(db: CloudDatabase) {
  const list = async (table: string, day: string) => {
    checkDay(day)
    return (await db.all(table))
      .filter((r) => r.day === day)
      .reverse()
      .map(clean)
  }
  const remove = (table: string, day: string, id: string) => {
    checkDay(day)
    return db.run([table], (t) => {
      const n = t[table].length
      t[table] = t[table].filter((r) => r.id !== id || r.day !== day)
      return n !== t[table].length
    })
  }
  return { list, remove }
}
