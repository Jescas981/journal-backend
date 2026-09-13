import type { DatabaseSync } from 'node:sqlite'
import { validDay } from '../../domain/dates.ts'
import { emptyReflection } from '../../domain/models.ts'
import type { DailyReflection } from '../../domain/models.types.d.ts'

export function createReflectionStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_reflections (
    day TEXT PRIMARY KEY,
    discomforts TEXT NOT NULL,
    actions TEXT NOT NULL,
    description TEXT NOT NULL,
    gratitude TEXT NOT NULL,
    rating INTEGER
  )`)

  const columns = db
    .prepare('PRAGMA table_info(daily_reflections)')
    .all()
    .map((column) => column.name)
  for (const name of ['undone', 'frequentProblem', 'mainProblem']) {
    if (!columns.includes(name))
      db.exec(
        `ALTER TABLE daily_reflections ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`,
      )
  }

  function checkDay(day: string) {
    if (!validDay(day)) throw new Error('Selecciona una fecha válida.')
  }

  function get(day: string): DailyReflection {
    checkDay(day)
    const row = db
      .prepare('SELECT * FROM daily_reflections WHERE day = ?')
      .get(day)
    if (!row) return { ...emptyReflection }
    const {
      discomforts,
      actions,
      description,
      gratitude,
      rating,
      undone,
      frequentProblem,
      mainProblem,
    } = row
    return {
      undone,
      frequentProblem,
      mainProblem,
      discomforts,
      actions,
      description,
      gratitude,
      rating,
    } as DailyReflection
  }

  return {
    get,
    save(day: string, value: DailyReflection) {
      checkDay(day)
      if (
        !value ||
        ![
          'discomforts',
          'actions',
          'description',
          'gratitude',
          'undone',
          'frequentProblem',
          'mainProblem',
        ].every((key) => {
          const text = value[key as keyof DailyReflection]
          return typeof text === 'string' && text.length <= 2000
        })
      )
        throw new Error('Cada respuesta admite hasta 2.000 caracteres.')
      if (
        value.rating !== null &&
        (!Number.isInteger(value.rating) ||
          value.rating < 0 ||
          value.rating > 10)
      ) {
        throw new Error('La calificación debe estar entre 0 y 10.')
      }
      db.prepare(
        `INSERT INTO daily_reflections (day, discomforts, actions, description, gratitude, rating, undone, frequentProblem, mainProblem)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET discomforts=excluded.discomforts,
        actions=excluded.actions, description=excluded.description,
        gratitude=excluded.gratitude, rating=excluded.rating,
        undone=excluded.undone, frequentProblem=excluded.frequentProblem, mainProblem=excluded.mainProblem`,
      ).run(
        day,
        value.discomforts,
        value.actions,
        value.description,
        value.gratitude,
        value.rating,
        value.undone,
        value.frequentProblem,
        value.mainProblem,
      )
      return get(day)
    },
  }
}
