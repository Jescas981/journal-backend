import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { emptyTask, isScoreTemplate } from '../../domain/models.ts'
import type {
  Goal,
  Objective,
  Task,
  TaskDraft,
} from '../../domain/models.types.d.ts'
import { nextDay, scheduledRange } from '../../domain/schedule.ts'
import { createImageStore } from './images.ts'
import { createJournalStore } from './journals.ts'
import { migrateFactorScale } from './migrations.ts'
import { createMoodStore } from './moods.ts'
import { createReflectionStore } from './reflections.ts'
import { createTemplates } from './templates.ts'

import type {
  CalendarCompletion,
  CalendarEntry,
  CalendarOutbox,
} from '../../domain/calendar.d.ts'

export function createStore(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, year INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS objectives (
      id TEXT PRIMARY KEY, goalId TEXT NOT NULL REFERENCES goals(id),
      title TEXT NOT NULL, targetHours REAL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', completed INTEGER NOT NULL DEFAULT 0,
      milestone INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_day ON tasks(day);
    CREATE INDEX IF NOT EXISTS idx_objectives_goal ON objectives(goalId);
    CREATE TABLE IF NOT EXISTS calendar_schedule_dirty (taskId TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS calendar_outbox (eventId TEXT PRIMARY KEY, day TEXT NOT NULL, completed INTEGER NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS calendar_imports (eventId TEXT PRIMARY KEY, taskId TEXT NOT NULL UNIQUE, day TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
  `)
  const columns = db
    .prepare('PRAGMA table_info(tasks)')
    .all()
    .map((column) => column.name)
  db.exec('BEGIN')
  try {
    for (const [name, definition] of Object.entries({
      objectiveId: 'TEXT REFERENCES objectives(id)',
      scoreTemplate: "TEXT NOT NULL DEFAULT 'work'",
      kind: "TEXT NOT NULL DEFAULT 'event'",
      startTime: 'TEXT',
      endTime: 'TEXT',
      timeZone: 'TEXT',
      importance: 'REAL NOT NULL DEFAULT 0',
      hours: 'REAL NOT NULL DEFAULT 0',
      depth: 'REAL NOT NULL DEFAULT 0',
      impact: 'REAL NOT NULL DEFAULT 0',
    })) {
      if (!columns.includes(name))
        db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`)
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_tasks_objective ON tasks(objectiveId)',
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  function tasks(day?: string): Task[] {
    if (day) templates.materialize(day)
    const query = `SELECT tasks.*, o.templateId, c.eventId AS calendarEventId FROM tasks
      LEFT JOIN template_occurrences o ON o.taskId = tasks.id
      LEFT JOIN calendar_imports c ON c.taskId = tasks.id`
    const rows = day
      ? db.prepare(`${query} WHERE tasks.day = ? ORDER BY tasks.rowid`).all(day)
      : db.prepare(`${query} ORDER BY tasks.day DESC, tasks.rowid`).all()
    return rows.map((row) => ({
      ...row,
      completed: Boolean(row.completed),
      milestone: Boolean(row.milestone),
    })) as Task[]
  }

  function scheduleHours(day: string, task: TaskDraft, id: string) {
    if (task.kind === 'task') return 0
    const previous = db
      .prepare(
        'SELECT t.* FROM tasks t JOIN calendar_imports c ON c.taskId=t.id WHERE t.id=? AND t.day=?',
      )
      .get(id, day)
    if (
      previous &&
      ['startTime', 'endTime', 'timeZone'].every(
        (key) => previous[key] === (task[key as keyof TaskDraft] ?? null),
      )
    )
      return previous.hours as number
    return scheduledRange(day, task)?.hours ?? task.hours
  }

  function queueSchedule(day: string, task: TaskDraft, id: string) {
    if (task.kind === 'task' || !task.startTime || !task.endTime) return
    const previous = db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
    if (
      !previous ||
      previous.day !== day ||
      ['title', 'description', 'startTime', 'endTime', 'timeZone'].some(
        (key) => previous[key] !== task[key as keyof TaskDraft],
      )
    ) {
      db.prepare(
        'INSERT INTO calendar_schedule_dirty VALUES (?, 1) ON CONFLICT(taskId) DO UPDATE SET revision=revision+1',
      ).run(id)
    }
  }
  function saveTask(
    day: string,
    task: TaskDraft,
    id: string = crypto.randomUUID(),
    update = false,
    fromCalendar = false,
    skipQueue = false,
  ) {
    if (task.kind !== undefined && !['event', 'task'].includes(task.kind))
      throw new Error('Selecciona Evento o Tarea.')
    if (task.kind === 'task')
      task = {
        ...task,
        hours: 0,
        startTime: null,
        endTime: null,
        timeZone: null,
      }
    if (!fromCalendar) task = { ...task, hours: scheduleHours(day, task, id) }
    const scoreTemplate =
      task.scoreTemplate === undefined ? 'work' : task.scoreTemplate
    if (!isScoreTemplate(scoreTemplate))
      throw new Error('Plantilla de score inválida.')
    if (
      task.objectiveId &&
      !db
        .prepare('SELECT id FROM objectives WHERE id = ?')
        .get(task.objectiveId)
    )
      throw new Error('El objetivo no existe.')
    if (!fromCalendar && !skipQueue) queueSchedule(day, task, id)
    const values = [
      task.title.trim(),
      task.description,
      Number(task.completed),
      Number(task.milestone),
      task.objectiveId,
      task.importance,
      task.hours,
      task.depth,
      task.impact,
      scoreTemplate,
      task.startTime ?? null,
      task.endTime ?? null,
      task.timeZone ?? null,
      task.kind ?? 'event',
      id,
      day,
    ]
    if (update) {
      const result = db
        .prepare(
          'UPDATE tasks SET title=?, description=?, completed=?, milestone=?, objectiveId=?, importance=?, hours=?, depth=?, impact=?, scoreTemplate=?, startTime=?, endTime=?, timeZone=?, kind=? WHERE id=? AND day=?',
        )
        .run(...values)
      if (!result.changes) throw new Error('La tarea no existe en esta fecha.')
    } else {
      db.prepare(
        'INSERT INTO tasks (title, description, completed, milestone, objectiveId, importance, hours, depth, impact, scoreTemplate, startTime, endTime, timeZone, kind, id, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(...values)
    }
    return { ...task, scoreTemplate, title: task.title.trim(), id, day }
  }

  const reflections = createReflectionStore(db)
  const images = createImageStore(db)
  const journals = createJournalStore(db)
  const moods = createMoodStore(db)
  const templates = createTemplates(db, saveTask)
  migrateFactorScale(db)
  db.exec('BEGIN')
  try {
    if (
      !db
        .prepare('SELECT name FROM migrations WHERE name=?')
        .get('calendar-completion-sync')
    ) {
      db.exec(`INSERT OR IGNORE INTO calendar_outbox (eventId, day, completed, revision)
        SELECT c.eventId, t.day, 1, 1 FROM calendar_imports c JOIN tasks t ON t.id=c.taskId WHERE t.completed=1`)
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(
        'calendar-completion-sync',
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  function queueCompletion(day: string, task: TaskDraft, id: string) {
    if (task.kind === 'task') return
    const previous = db
      .prepare(
        'SELECT t.completed, c.eventId FROM tasks t JOIN calendar_imports c ON c.taskId=t.id WHERE t.id=? AND t.day=?',
      )
      .get(id, day)
    if (previous && Boolean(previous.completed) !== task.completed) {
      db.prepare(
        `INSERT INTO calendar_outbox VALUES (?, ?, ?, 1)
        ON CONFLICT(eventId) DO UPDATE SET completed=excluded.completed, day=excluded.day, revision=calendar_outbox.revision+1`,
      ).run(previous.eventId, day, Number(task.completed))
    }
  }

  const calendarOutbox: CalendarOutbox = {
    pending: (day) =>
      (day
        ? db.prepare('SELECT * FROM calendar_outbox WHERE day=?').all(day)
        : db
            .prepare('SELECT * FROM calendar_outbox')
            .all()) as CalendarCompletion[],
    acknowledge: (change) => {
      db.prepare(
        'DELETE FROM calendar_outbox WHERE eventId=? AND revision=?',
      ).run(change.eventId, change.revision)
    },
  }

  return {
    tasks,
    calendarOutbox,
    calendarSchedule: {
      pending: () =>
        db.prepare('SELECT * FROM calendar_schedule_dirty').all() as {
          taskId: string
          revision: number
        }[],
      acknowledge: (taskId: string, revision: number) => {
        db.prepare(
          'DELETE FROM calendar_schedule_dirty WHERE taskId=? AND revision=?',
        ).run(taskId, revision)
      },
      tasks: (day: string) => {
        const today = new Date().toLocaleDateString('en-CA', {
          timeZone: 'America/Lima',
        })
        const limit = nextDay(today, 2)
        if (day <= limit) templates.materialize(day)
        for (let offset = 0; offset <= 2; offset++)
          templates.materialize(nextDay(today, offset))
        const candidates = tasks().filter((task) => {
          if (!task.templateId || task.day <= limit || task.completed)
            return true
          return Boolean(
            db
              .prepare(
                'SELECT customized FROM template_occurrences WHERE taskId=?',
              )
              .get(task.id)?.customized,
          )
        })
        for (const task of candidates) {
          if (
            task.kind !== 'task' &&
            task.startTime &&
            task.endTime &&
            !task.calendarEventId
          )
            db.prepare(
              'INSERT OR IGNORE INTO calendar_schedule_dirty VALUES (?, 1)',
            ).run(task.id)
        }
        return candidates
      },
      unlink: (taskId: string, eventId: string) => {
        db.prepare(
          'DELETE FROM calendar_imports WHERE taskId=? AND eventId=?',
        ).run(taskId, eventId)
        db.prepare('DELETE FROM calendar_outbox WHERE eventId=?').run(eventId)
      },
      link: (taskId: string, eventId: string, day: string) => {
        db.prepare(
          'INSERT INTO calendar_imports VALUES (?, ?, ?) ON CONFLICT(eventId) DO UPDATE SET taskId=excluded.taskId, day=excluded.day',
        ).run(eventId, taskId, day)
      },
    },
    importCalendar: (day: string, entries: CalendarEntry[]) => {
      db.exec('BEGIN')
      try {
        const present = new Set(entries.map((entry) => entry.eventId))
        const previous = db
          .prepare('SELECT * FROM calendar_imports WHERE day=?')
          .all(day)
        for (const link of previous) {
          if (
            !present.has(link.eventId as string) &&
            !db
              .prepare(
                'SELECT taskId FROM calendar_schedule_dirty WHERE taskId=?',
              )
              .get(link.taskId) &&
            !db
              .prepare('SELECT eventId FROM calendar_outbox WHERE eventId=?')
              .get(link.eventId)
          ) {
            templates.noteRemoval(day, link.taskId as string)
            // Preserve completed work as history when its event disappears.
            db.prepare('DELETE FROM tasks WHERE id=? AND completed=0').run(
              link.taskId,
            )
            if (!db.prepare('SELECT id FROM tasks WHERE id=?').get(link.taskId))
              db.prepare('DELETE FROM calendar_imports WHERE eventId=?').run(
                link.eventId,
              )
          }
        }
        for (const entry of entries) {
          let taskId = `gcal-${createHash('sha256').update(entry.eventId).digest('hex')}`
          const link = db
            .prepare('SELECT * FROM calendar_imports WHERE eventId=?')
            .get(entry.eventId)
          if (link) taskId = link.taskId as string
          const existing = db
            .prepare('SELECT * FROM tasks WHERE id=?')
            .get(taskId) as Task | undefined
          if (
            db
              .prepare(
                'SELECT taskId FROM calendar_schedule_dirty WHERE taskId=?',
              )
              .get(taskId)
          )
            continue
          if (existing?.kind === 'task') continue
          // A task explicitly removed in Journal stays removed on later refreshes.
          if (link && !existing && link.day === day) continue
          if (
            db
              .prepare('SELECT eventId FROM calendar_outbox WHERE eventId=?')
              .get(entry.eventId)
          )
            continue
          const draft = {
            ...emptyTask,
            ...existing,
            kind: 'event' as const,
            title: entry.title,
            description: entry.description,
            hours: entry.hours,
            startTime: entry.startTime ?? existing?.startTime ?? null,
            endTime: entry.endTime ?? existing?.endTime ?? null,
            timeZone: entry.timeZone ?? existing?.timeZone ?? null,
            completed: entry.completed ?? Boolean(existing?.completed),
            milestone: Boolean(existing?.milestone),
          }
          if (existing)
            db.prepare('UPDATE tasks SET day=? WHERE id=?').run(day, taskId)
          if (existing) templates.noteEdit(day, draft, taskId)
          saveTask(day, draft, taskId, Boolean(existing), true)
          db.prepare(
            'INSERT INTO calendar_imports VALUES (?, ?, ?) ON CONFLICT(eventId) DO UPDATE SET day=excluded.day',
          ).run(entry.eventId, taskId, day)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    templates,
    moods,
    journals,
    images,
    reflections,
    saveTask: (
      day: string,
      task: TaskDraft,
      id: string = crypto.randomUUID(),
      update = false,
    ) => {
      db.exec('BEGIN')
      try {
        queueCompletion(day, task, id)
        if (update) templates.noteEdit(day, task, id)
        const result = saveTask(day, task, id, update)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    saveDay: (day: string, entries: Task[]) => {
      db.exec('BEGIN')
      try {
        entries = entries.map((task) => ({
          ...task,
          hours: scheduleHours(day, task, task.id),
        }))
        const retained = new Set(entries.map((task) => task.id))
        const old = db.prepare('SELECT id FROM tasks WHERE day = ?').all(day)
        for (const task of old) {
          if (!retained.has(task.id as string))
            templates.noteRemoval(day, task.id as string)
        }
        for (const task of entries) {
          queueSchedule(day, task, task.id)
          queueCompletion(day, task, task.id)
          templates.noteEdit(day, task, task.id)
        }
        db.prepare('DELETE FROM tasks WHERE day = ?').run(day)
        for (const task of entries)
          saveTask(day, task, task.id, false, true, true)
        db.exec('COMMIT')
        return tasks(day)
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    reportEntries: (start: string, end: string) => ({
      moods: db
        .prepare(
          'SELECT * FROM mood_records WHERE day BETWEEN ? AND ? ORDER BY day, recordedAt',
        )
        .all(start, end),
      journals: db
        .prepare(
          'SELECT * FROM journal_records WHERE day BETWEEN ? AND ? ORDER BY day, createdAt',
        )
        .all(start, end),
      reflections: db
        .prepare(
          'SELECT * FROM daily_reflections WHERE day BETWEEN ? AND ? ORDER BY day',
        )
        .all(start, end),
      images: db
        .prepare(
          'SELECT id, day, name, mimeType, size, uploadedAt, cropZoom, cropX, cropY FROM entry_images WHERE day BETWEEN ? AND ? ORDER BY day, uploadedAt',
        )
        .all(start, end),
    }),
    reportExtras: () => ({
      moods: db
        .prepare('SELECT day, score FROM mood_records ORDER BY day')
        .all(),
      journalDays: db
        .prepare('SELECT day FROM journal_records ORDER BY day')
        .all()
        .map((row) => row.day),
      imageDays: db
        .prepare('SELECT day FROM entry_images ORDER BY day')
        .all()
        .map((row) => row.day),
      reflectionDays: db
        .prepare(
          "SELECT day FROM daily_reflections WHERE discomforts<>'' OR actions<>'' OR description<>'' OR gratitude<>'' OR undone<>'' OR frequentProblem<>'' OR mainProblem<>'' OR rating IS NOT NULL ORDER BY day",
        )
        .all()
        .map((row) => row.day),
    }),
    overview: () => ({
      goals: db
        .prepare('SELECT * FROM goals ORDER BY year DESC, rowid')
        .all() as Goal[],
      objectives: db
        .prepare('SELECT * FROM objectives ORDER BY rowid')
        .all() as Objective[],
      tasks: tasks(),
    }),
    deleteTask: (day: string, id: string) => {
      templates.noteRemoval(day, id)
      return db
        .prepare('DELETE FROM tasks WHERE day = ? AND id = ?')
        .run(day, id)
    },
    saveGoal: (goal: Goal, update: boolean) => {
      if (update) {
        if (
          !db
            .prepare('UPDATE goals SET title=?, year=? WHERE id=?')
            .run(goal.title, goal.year, goal.id).changes
        )
          throw new Error('La meta no existe.')
      } else
        db.prepare('INSERT INTO goals (id, title, year) VALUES (?, ?, ?)').run(
          goal.id,
          goal.title,
          goal.year,
        )
      return goal
    },
    saveObjective: (objective: Objective, update: boolean) => {
      if (!db.prepare('SELECT id FROM goals WHERE id=?').get(objective.goalId))
        throw new Error('La meta no existe.')
      if (update) {
        if (
          !db
            .prepare(
              'UPDATE objectives SET title=?, targetHours=? WHERE id=? AND goalId=?',
            )
            .run(
              objective.title,
              objective.targetHours,
              objective.id,
              objective.goalId,
            ).changes
        )
          throw new Error('El objetivo no existe.')
      } else
        db.prepare(
          'INSERT INTO objectives (id, goalId, title, targetHours) VALUES (?, ?, ?, ?)',
        ).run(
          objective.id,
          objective.goalId,
          objective.title,
          objective.targetHours,
        )
      return objective
    },
    close: () => db.close(),
  }
}
