import { emptyReflection } from '../../domain/models.ts'
import type { DailyReflection } from '../../domain/models.types.d.ts'
import { checkDay } from '../../domain/validation.ts'
import type { CloudDatabase } from './database.ts'
import { clean } from './records.ts'

export function createReflectionsRepository(db: CloudDatabase) {
  return {
    get: async (day: string) => {
      checkDay(day)
      return clean(
        (await db.get('daily_reflections', { day })) ?? {
          ...emptyReflection,
        },
      )
    },
    save: (day: string, value: DailyReflection) => {
      checkDay(day)
      if (
        !value ||
        Object.keys(emptyReflection)
          .filter((k) => k !== 'rating')
          .some(
            (k) =>
              typeof value[k as keyof DailyReflection] !== 'string' ||
              String(value[k as keyof DailyReflection]).length > 2000,
          ) ||
        !(
          value.rating === null ||
          (Number.isInteger(value.rating) &&
            Number(value.rating) >= 0 &&
            Number(value.rating) <= 10)
        )
      )
        throw new Error('Revisa las respuestas del formulario.')
      const record = {
        day,
        ...Object.fromEntries(
          Object.keys(emptyReflection).map((k) => [
            k,
            value[k as keyof DailyReflection],
          ]),
        ),
      }
      return db.run(
        ['daily_reflections'],
        (t) => {
          t.daily_reflections = t.daily_reflections.filter((r) => r.day !== day)
          t.daily_reflections.push(record)
          return clean(record)
        },
        { daily_reflections: [[{ field: 'day', op: '==', value: day }]] },
      )
    },
  }
}
