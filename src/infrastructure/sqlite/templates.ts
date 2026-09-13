import type { DatabaseSync } from 'node:sqlite'
import { validDay } from '../../domain/dates.ts'
import { everyDay, isScoreTemplate } from '../../domain/models.ts'
import type { TaskDraft, TaskTemplate } from '../../domain/models.types.d.ts'
import { scheduledRange } from '../../domain/schedule.ts'
import type { Occurrence } from './templates.types.d.ts'

const contentKeys = [
  'kind',
  'title',
  'description',
  'milestone',
  'objectiveId',
  'hours',
  'importance',
  'depth',
  'impact',
  'scoreTemplate',
  'startTime',
  'endTime',
  'timeZone',
] as const

export function createTemplates(
  db: DatabaseSync,
  writeTask: (
    day: string,
    task: TaskDraft,
    id: string,
    update?: boolean,
  ) => unknown,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id TEXT PRIMARY KEY,
      startsOn TEXT NOT NULL,
      archivedOn TEXT
    );
    CREATE TABLE IF NOT EXISTS template_versions (
      templateId TEXT NOT NULL REFERENCES task_templates(id),
      effectiveDay TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (templateId, effectiveDay)
    );
    CREATE TABLE IF NOT EXISTS template_occurrences (
      templateId TEXT NOT NULL REFERENCES task_templates(id),
      day TEXT NOT NULL,
      taskId TEXT NOT NULL UNIQUE,
      customized INTEGER NOT NULL DEFAULT 0,
      suppressed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (templateId, day)
    );
    CREATE INDEX IF NOT EXISTS idx_occurrences_day ON template_occurrences(day);
  `)

  function active(day: string): TaskTemplate[] {
    const rows = db
      .prepare(
        `
      SELECT t.id, t.startsOn, v.content
      FROM task_templates t
      JOIN template_versions v ON v.templateId = t.id
      WHERE t.startsOn <= ? AND (t.archivedOn IS NULL OR t.archivedOn > ?)
        AND v.effectiveDay = (
          SELECT MAX(effectiveDay) FROM template_versions
          WHERE templateId = t.id AND effectiveDay <= ?
        )
      ORDER BY t.rowid
    `,
      )
      .all(day, day, day)
    return rows.map((row) => ({
      kind: 'event',
      weekdays: [...everyDay],
      startTime: null,
      endTime: null,
      timeZone: null,
      scoreTemplate: 'work',
      ...JSON.parse(row.content as string),
      id: row.id,
      startsOn: row.startsOn,
    }))
  }

  // One persisted occurrence per template/day also records deletions for that day.
  function syncDay(day: string) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
    const templates = active(day).filter((template) =>
      template.weekdays!.includes(weekday),
    )
    const activeIds = new Set(templates.map((template) => template.id))
    for (const template of templates) {
      let occurrence = db
        .prepare(
          'SELECT * FROM template_occurrences WHERE templateId = ? AND day = ?',
        )
        .get(template.id, day) as Occurrence | undefined
      if (!occurrence) {
        occurrence = {
          templateId: template.id,
          day,
          taskId: crypto.randomUUID(),
          customized: 0,
          suppressed: 0,
        }
        db.prepare(
          'INSERT INTO template_occurrences (templateId, day, taskId) VALUES (?, ?, ?)',
        ).run(template.id, day, occurrence.taskId)
      }
      if (occurrence.suppressed || occurrence.customized) continue
      const existing = db
        .prepare('SELECT completed FROM tasks WHERE id = ?')
        .get(occurrence.taskId)
      if (existing?.completed) continue
      writeTask(
        day,
        { ...template, completed: false },
        occurrence.taskId,
        Boolean(existing),
      )
    }
    const occurrences = db
      .prepare('SELECT * FROM template_occurrences WHERE day = ?')
      .all(day) as Occurrence[]
    for (const occurrence of occurrences) {
      if (!activeIds.has(occurrence.templateId) && !occurrence.customized) {
        db.prepare('DELETE FROM tasks WHERE id = ? AND completed = 0').run(
          occurrence.taskId,
        )
      }
    }
  }

  function transaction<T>(action: () => T) {
    db.exec('BEGIN')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function syncExisting(from: string) {
    // Refresh already opened future days too, while preserving completed/custom tasks.
    const days = db
      .prepare(
        `
      SELECT day FROM tasks WHERE day >= ?
      UNION SELECT day FROM template_occurrences WHERE day >= ?
      UNION SELECT ? AS day
    `,
      )
      .all(from, from, from)
    for (const { day } of days) syncDay(day as string)
  }

  return {
    list: active,
    applyToDay: (id: string, day: string, sourceDay: string) =>
      transaction(() => {
        if (!validDay(day) || !validDay(sourceDay))
          throw new Error('Selecciona una fecha válida.')
        const template = active(sourceDay).find((item) => item.id === id)
        if (!template) throw new Error('La plantilla no está activa.')
        const occurrence = db
          .prepare(
            'SELECT * FROM template_occurrences WHERE templateId = ? AND day = ?',
          )
          .get(id, day) as Occurrence | undefined
        if (
          occurrence &&
          db.prepare('SELECT id FROM tasks WHERE id = ?').get(occurrence.taskId)
        ) {
          return { taskId: occurrence.taskId, added: false }
        }
        const taskId = occurrence?.taskId ?? crypto.randomUUID()
        // Explicit application is a snapshot, even before the recurrence starts.
        // Preserve it during future synchronization and remember per-day deletion.
        db.prepare(
          `
        INSERT INTO template_occurrences (templateId, day, taskId, customized, suppressed)
        VALUES (?, ?, ?, 1, 0)
        ON CONFLICT (templateId, day) DO UPDATE SET customized = 1, suppressed = 0
      `,
        ).run(id, day, taskId)
        writeTask(day, { ...template, completed: false }, taskId)
        return { taskId, added: true }
      }),
    materialize: (day: string) => transaction(() => syncDay(day)),
    save: (
      draft: TaskDraft,
      day: string,
      id: string = crypto.randomUUID(),
      update = false,
    ) =>
      transaction(() => {
        if (draft.kind !== undefined && !['event', 'task'].includes(draft.kind))
          throw new Error('Selecciona Evento o Tarea.')
        if (draft.kind === 'task')
          draft = {
            ...draft,
            hours: 0,
            startTime: null,
            endTime: null,
            timeZone: null,
          }
        const weekdays = draft.weekdays ?? [...everyDay]
        if (
          !Array.isArray(weekdays) ||
          weekdays.length === 0 ||
          weekdays.length > 7 ||
          new Set(weekdays).size !== weekdays.length ||
          !weekdays.every(
            (value) => Number.isInteger(value) && value >= 0 && value <= 6,
          )
        )
          throw new Error('Selecciona al menos un día de la semana válido.')
        draft = { ...draft, weekdays }
        const range = scheduledRange(day, draft)
        if (range) draft = { ...draft, hours: range.hours }
        const scoreTemplate =
          draft.scoreTemplate === undefined ? 'work' : draft.scoreTemplate
        if (!isScoreTemplate(scoreTemplate))
          throw new Error('Plantilla de score inválida.')
        const template = db
          .prepare('SELECT * FROM task_templates WHERE id = ?')
          .get(id)
        if (
          update &&
          (!template ||
            template.archivedOn ||
            (template.startsOn as string) > day)
        )
          throw new Error('La plantilla no está activa en esta fecha.')
        if (!update)
          db.prepare(
            'INSERT INTO task_templates (id, startsOn) VALUES (?, ?)',
          ).run(id, day)
        db.prepare(
          `
        INSERT INTO template_versions (templateId, effectiveDay, content) VALUES (?, ?, ?)
        ON CONFLICT (templateId, effectiveDay) DO UPDATE SET content = excluded.content
      `,
        ).run(
          id,
          day,
          JSON.stringify({ ...draft, scoreTemplate, completed: false }),
        )
        syncExisting(day)
        return active(day).find((item) => item.id === id)!
      }),
    archive: (id: string, day: string) =>
      transaction(() => {
        if (
          !db
            .prepare(
              'UPDATE task_templates SET archivedOn = ? WHERE id = ? AND archivedOn IS NULL AND startsOn <= ?',
            )
            .run(day, id, day).changes
        )
          throw new Error('La plantilla no está activa.')
        syncExisting(day)
      }),
    noteEdit: (day: string, task: TaskDraft, id: string) => {
      const previous = db
        .prepare('SELECT * FROM tasks WHERE id = ? AND day = ?')
        .get(id, day)
      if (
        previous &&
        contentKeys.some((key) =>
          key === 'milestone'
            ? Boolean(previous[key]) !== task[key]
            : previous[key] !==
              (key === 'kind'
                ? (task.kind ?? 'event')
                : key === 'scoreTemplate'
                  ? (task[key] ?? 'work')
                  : ['startTime', 'endTime', 'timeZone'].includes(key)
                    ? (task[key] ?? null)
                    : task[key]),
        )
      ) {
        db.prepare(
          'UPDATE template_occurrences SET customized = 1 WHERE taskId = ? AND day = ?',
        ).run(id, day)
      }
    },
    noteRemoval: (day: string, id: string) => {
      db.prepare(
        'UPDATE template_occurrences SET suppressed = 1 WHERE taskId = ? AND day = ?',
      ).run(id, day)
    },
  }
}
