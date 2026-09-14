import type { Selections, Filter } from './queries.d.ts'
import { emptyReflection } from '../../domain/models.ts'
import type {
  Goal,
  Objective,
  Task,
  TaskDraft,
} from '../../domain/models.types.d.ts'
import { Domain, taskTables } from '../../domain/task-workflow.ts'
import { CloudDatabase } from './database.ts'
import { createImagesRepository } from './images.ts'
import { createJournalsRepository } from './journals.ts'
import { createMoodsRepository } from './moods.ts'
import { createReflectionsRepository } from './reflections.ts'

import type {
  CalendarCompletion,
  CalendarEntry,
} from '../../domain/calendar.d.ts'

import { checkDay } from '../../domain/validation.ts'
import { clean } from './records.ts'

export function createCloudStore(db: CloudDatabase) {
  const domain = <T>(action: (d: Domain) => T) =>
    db.run(taskTables, (t) => action(new Domain(t)))
  const dayDomain = <T>(
    day: string,
    action: (d: Domain) => T,
    ids: string[] = [],
  ) => {
    checkDay(day)
    const byDay: Filter[] = [{ field: 'day', op: '==', value: day }]
    const byIds = (field: string): Filter[][] => {
      const unique = [...new Set(ids)]
      return Array.from(
        { length: Math.ceil(unique.length / 30) },
        (_, index) => [
          { field, op: 'in', value: unique.slice(index * 30, index * 30 + 30) },
        ],
      )
    }
    const selections: Selections = {
      goals: [],
      tasks: [byDay, ...byIds('id')],
      template_occurrences: [byDay],
      calendar_imports: [byDay, ...byIds('taskId')],
    }
    return db.run(
      taskTables,
      (tables) => action(new Domain(tables)),
      selections,
    )
  }
  const records = {
    moods: createMoodsRepository(db),
    journals: createJournalsRepository(db),
    reflections: createReflectionsRepository(db),
    images: createImagesRepository(db),
  }
  return {
    ...records,
    tasks: (day?: string) =>
      day ? dayDomain(day, (d) => d.tasks(day)) : domain((d) => d.tasks()),
    saveTask: (day: string, task: TaskDraft, id?: string, update = false) =>
      dayDomain(day, (d) => d.save(day, task, id, update), id ? [id] : []),
    saveDay: (day: string, tasks: Task[]) =>
      dayDomain(
        day,
        (d) => d.saveDay(day, tasks),
        tasks.map((task) => task.id),
      ),
    deleteTask: (day: string, id: string) =>
      dayDomain(day, (d) => {
        d.noteRemoval(day, id)
        return {
          changes: d.remove('tasks', (t) => t.id === id && t.day === day),
        }
      }),
    saveGoal: (goal: Goal, update: boolean) =>
      domain((d) => {
        if (update && !d.find('goals', 'id', goal.id))
          throw new Error('La meta no existe.')
        d.put('goals', goal)
        return goal
      }),
    saveObjective: (objective: Objective, update: boolean) =>
      domain((d) => {
        if (!d.find('goals', 'id', objective.goalId))
          throw new Error('La meta no existe.')
        if (
          update &&
          d.find('objectives', 'id', objective.id)?.goalId !== objective.goalId
        )
          throw new Error('El objetivo no existe.')
        d.put('objectives', objective)
        return objective
      }),
    overview: () =>
      db.read(
        [
          'goals',
          'objectives',
          'tasks',
          'template_occurrences',
          'calendar_imports',
        ],
        (tables) => {
          const d = new Domain(tables)
          return {
            goals: d
              .rows('goals')
              .map(clean)
              .sort((a, b) => b.year - a.year),
            objectives: d.rows('objectives').map(clean),
            tasks: d
              .tasks()
              .map((task) => clean(task) as Task)
              .sort((a, b) => b.day.localeCompare(a.day)),
          }
        },
      ),
    reportEntries: async (start: string, end: string) => {
      const read = async (name: string) =>
        (
          await db.all(name, [
            { field: 'day', op: '>=', value: start },
            { field: 'day', op: '<=', value: end },
          ])
        )
          .sort((a, b) => a.day.localeCompare(b.day))
          .map(clean)
      const [moods, journals, reflections, images] = await Promise.all(
        [
          'mood_records',
          'journal_records',
          'daily_reflections',
          'entry_images',
        ].map(read),
      )
      return { moods, journals, reflections, images }
    },
    reportExtras: async () => {
      const [moods, journals, images, reflections] = await Promise.all(
        [
          'mood_records',
          'journal_records',
          'entry_images',
          'daily_reflections',
        ].map((t) => db.all(t)),
      )
      return {
        moods: moods.map(({ day, score }) => ({ day, score })),
        journalDays: journals.map((r) => r.day),
        imageDays: images.map((r) => r.day),
        reflectionDays: reflections
          .filter((r) =>
            Object.keys(emptyReflection).some((k) =>
              k === 'rating' ? r[k] !== null : Boolean(r[k]),
            ),
          )
          .map((r) => r.day),
      }
    },
    templates: {
      list: (day: string) =>
        db.read(['task_templates', 'template_versions'], (tables) =>
          new Domain(tables).active(day),
        ),
      save: (draft: TaskDraft, day: string, id?: string, update = false) =>
        domain((d) => d.saveTemplate(draft, day, id, update)),
      applyToDay: (id: string, day: string, sourceDay: string) =>
        domain((d) => {
          checkDay(day)
          checkDay(sourceDay)
          return d.applyTemplate(id, day, sourceDay)
        }),
      archive: (id: string, day: string) =>
        domain((d) => {
          const t = d.find('task_templates', 'id', id)
          if (!t || t.archivedOn || t.startsOn > day)
            throw new Error('La plantilla no está activa.')
          t.archivedOn = day
          d.syncExisting(day)
        }),
    },
    importCalendar: (day: string, entries: CalendarEntry[]) =>
      domain((d) => d.importCalendar(day, entries)),
    calendarOutbox: {
      pending: async (day?: string) =>
        (await db.all('calendar_outbox')).filter(
          (r) => !day || r.day === day,
        ) as CalendarCompletion[],
      acknowledge: (change: CalendarCompletion) =>
        domain((d) => {
          d.remove(
            'calendar_outbox',
            (r) =>
              r.eventId === change.eventId && r.revision === change.revision,
          )
        }),
    },
    calendarSchedule: {
      tasks: (day: string) => domain((d) => d.scheduledTasks(day)),
      pending: async () =>
        (await db.all('calendar_schedule_dirty')) as {
          taskId: string
          revision: number
        }[],
      acknowledge: (taskId: string, revision: number) =>
        domain((d) => {
          d.remove(
            'calendar_schedule_dirty',
            (r) => r.taskId === taskId && r.revision === revision,
          )
        }),
      link: (taskId: string, eventId: string, day: string) =>
        domain((d) => {
          const old = d.find('calendar_imports', 'taskId', taskId)
          if (old && old.eventId !== eventId)
            throw new Error('La tarea ya pertenece a otro evento.')
          d.put('calendar_imports', { taskId, eventId, day }, 'eventId')
        }),
      unlink: (taskId: string, eventId: string) =>
        domain((d) => {
          d.remove(
            'calendar_imports',
            (r) => r.taskId === taskId && r.eventId === eventId,
          )
          d.remove('calendar_outbox', (r) => r.eventId === eventId)
        }),
    },
    close: () => db.close(),
  }
}
