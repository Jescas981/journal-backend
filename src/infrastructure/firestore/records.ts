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
    return (await db.all(table, [{ field: 'day', op: '==', value: day }]))
      .reverse()
      .map(clean)
  }
  const remove = (table: string, day: string, id: string) => {
    checkDay(day)
    let removed = false
    return db
      .change(table, { id }, (row) => {
        removed = Boolean(row && row.day === day)
        return removed ? undefined : row
      })
      .then(() => removed)
  }
  return { list, remove }
}
