import { createHash, randomUUID } from 'node:crypto'
import { emptyTask, everyDay, isScoreTemplate } from './models.ts'
import type { Task, TaskDraft } from './models.types.d.ts'

import type { CalendarEntry } from './calendar.d.ts'
import { nextDay, scheduledRange } from './schedule.ts'

import type { Row, Tables } from './records.d.ts'

export const taskTables = [
  'tasks',
  'goals',
  'objectives',
  'task_templates',
  'template_versions',
  'template_occurrences',
  'calendar_imports',
  'calendar_outbox',
  'calendar_schedule_dirty',
]
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
]
export class Domain {
  tables: Tables
  constructor(tables: Tables) {
    this.tables = tables
  }
  rows(name: string) {
    return this.tables[name]
  }
  find(name: string, key: string, value: unknown) {
    return this.rows(name).find((row) => row[key] === value)
  }
  remove(name: string, predicate: (row: Row) => boolean) {
    const before = this.rows(name).length
    this.tables[name] = this.rows(name).filter((row) => !predicate(row))
    return before - this.rows(name).length
  }
  put(name: string, row: Row, key = 'id') {
    const old = this.find(name, key, row[key])
    if (old) Object.assign(old, row)
    else
      this.rows(name).push({
        ...row,
        _order: Date.now() * 1000 + this.rows(name).length,
      })
  }
  active(day: string) {
    return this.rows('task_templates')
      .filter((t) => t.startsOn <= day && (!t.archivedOn || t.archivedOn > day))
      .flatMap((t) => {
        const version = this.rows('template_versions')
          .filter((v) => v.templateId === t.id && v.effectiveDay <= day)
          .sort((a, b) => b.effectiveDay.localeCompare(a.effectiveDay))[0]
        return version
          ? [
              {
                ...emptyTask,
                weekdays: [...everyDay],
                ...JSON.parse(version.content),
                id: t.id,
                startsOn: t.startsOn,
              },
            ]
          : []
      })
  }
  occurrence(id: string) {
    return this.find('template_occurrences', 'taskId', id)
  }
  noteRemoval(day: string, id: string) {
    const o = this.occurrence(id)
    if (o?.day === day) o.suppressed = 1
  }
  noteEdit(day: string, task: Row, id: string) {
    const previous = this.find('tasks', 'id', id)
    const o = this.occurrence(id)
    if (
      previous?.day === day &&
      o?.day === day &&
      contentKeys.some((key) => {
        const fallback =
          key === 'kind' ? 'event' : key === 'scoreTemplate' ? 'work' : null
        return key === 'milestone'
          ? Boolean(previous[key]) !== Boolean(task[key])
          : (previous[key] ?? fallback) !== (task[key] ?? fallback)
      })
    )
      o.customized = 1
  }
  queue(name: string, key: string, value: string, fields: Row = {}) {
    const before = this.find(name, key, value)
    this.put(
      name,
      { [key]: value, ...fields, revision: (before?.revision || 0) + 1 },
      key,
    )
  }
  hours(day: string, task: TaskDraft, id: string) {
    if (task.kind === 'task') return 0
    const prior = this.find('tasks', 'id', id)
    if (
      prior?.day === day &&
      this.find('calendar_imports', 'taskId', id) &&
      ['startTime', 'endTime', 'timeZone'].every(
        (key) =>
          (prior[key] ?? null) === (task[key as keyof TaskDraft] ?? null),
      )
    )
      return prior.hours
    return scheduledRange(day, task)?.hours ?? task.hours
  }
  write(
    day: string,
    draft: TaskDraft,
    id: string,
    update = false,
    fromCalendar = false,
    skipQueue = false,
  ) {
    if (draft.kind !== undefined && !['task', 'event'].includes(draft.kind))
      throw new Error('Selecciona Evento o Tarea.')
    const previous = this.find('tasks', 'id', id)
    if (update && previous?.day !== day)
      throw new Error('La tarea no existe en esta fecha.')
    if (!update && previous)
      throw new Error('El identificador de la tarea ya existe.')
    const task: Row = {
      ...emptyTask,
      ...draft,
      id,
      day,
      title: draft.title.trim(),
    }
    if (task.kind === 'task')
      Object.assign(task, {
        hours: 0,
        startTime: null,
        endTime: null,
        timeZone: null,
      })
    if (!fromCalendar) task.hours = this.hours(day, task as TaskDraft, id)
    if (!isScoreTemplate(task.scoreTemplate))
      throw new Error('Plantilla de score inválida.')
    if (task.objectiveId && !this.find('objectives', 'id', task.objectiveId))
      throw new Error('El objetivo no existe.')
    if (
      !fromCalendar &&
      !skipQueue &&
      task.kind !== 'task' &&
      task.startTime &&
      task.endTime &&
      (!previous ||
        previous.day !== day ||
        ['title', 'description', 'startTime', 'endTime', 'timeZone'].some(
          (key) => previous[key] !== task[key],
        ))
    )
      this.queue('calendar_schedule_dirty', 'taskId', id)
    delete task.templateId
    delete task.calendarEventId
    delete task.startsOn
    delete task.weekdays
    this.put('tasks', task)
    return task
  }
  completion(day: string, task: Row, id: string) {
    const before = this.find('tasks', 'id', id)
    const link = this.find('calendar_imports', 'taskId', id)
    if (
      task.kind !== 'task' &&
      before?.day === day &&
      link &&
      Boolean(before.completed) !== Boolean(task.completed)
    )
      this.queue('calendar_outbox', 'eventId', link.eventId, {
        day,
        completed: Number(task.completed),
      })
  }
  save(
    day: string,
    task: TaskDraft,
    id: string = randomUUID(),
    update = false,
  ) {
    this.completion(day, task, id)
    if (update) this.noteEdit(day, task, id)
    return this.write(day, task, id, update)
  }
  syncDay(day: string) {
    const templates = this.active(day).filter((t) =>
      t.weekdays.includes(new Date(`${day}T12:00:00Z`).getUTCDay()),
    )
    for (const template of templates) {
      let occurrence = this.rows('template_occurrences').find(
        (o) => o.templateId === template.id && o.day === day,
      )
      if (!occurrence) {
        occurrence = {
          templateId: template.id,
          day,
          taskId: randomUUID(),
          customized: 0,
          suppressed: 0,
        }
        this.rows('template_occurrences').push(occurrence)
      }
      if (occurrence.customized || occurrence.suppressed) continue
      const old = this.find('tasks', 'id', occurrence.taskId)
      if (old?.completed) continue
      this.write(
        day,
        { ...template, completed: false },
        occurrence.taskId,
        Boolean(old),
      )
    }
    for (const o of this.rows('template_occurrences').filter(
      (o) =>
        o.day === day &&
        !o.customized &&
        !templates.some((t) => t.id === o.templateId),
    ))
      this.remove('tasks', (t) => t.id === o.taskId && !t.completed)
  }
  tasks(day?: string) {
    if (day) this.syncDay(day)
    return this.rows('tasks')
      .filter((t) => !day || t.day === day)
      .map((t) => ({
        ...t,
        completed: Boolean(t.completed),
        milestone: Boolean(t.milestone),
        templateId: this.occurrence(t.id)?.templateId ?? null,
        calendarEventId:
          this.find('calendar_imports', 'taskId', t.id)?.eventId ?? null,
      })) as Task[]
  }
  saveDay(day: string, entries: Task[]) {
    const normalized = entries.map((task) => ({
      ...task,
      hours: this.hours(day, task, task.id),
    }))
    for (const task of normalized) {
      const old = this.find('tasks', 'id', task.id)
      if (old && old.day !== day)
        throw new Error('La tarea pertenece a otra fecha.')
      this.completion(day, task, task.id)
      this.noteEdit(day, task, task.id)
    }
    for (const old of this.rows('tasks').filter(
      (old) => old.day === day && !entries.some((t) => t.id === old.id),
    )) {
      this.noteRemoval(day, old.id)
      this.remove('tasks', (t) => t.id === old.id)
    }
    for (const task of normalized)
      this.write(day, task, task.id, Boolean(this.find('tasks', 'id', task.id)))
    return this.tasks(day)
  }
  syncExisting(from: string) {
    for (const day of new Set([
      from,
      ...this.rows('tasks').map((t) => t.day),
      ...this.rows('template_occurrences').map((t) => t.day),
    ]))
      if (day >= from) this.syncDay(day)
  }
  saveTemplate(
    draft: TaskDraft,
    day: string,
    id: string = randomUUID(),
    update = false,
  ) {
    if (draft.kind !== undefined && !['task', 'event'].includes(draft.kind))
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
      !weekdays.length ||
      weekdays.length > 7 ||
      new Set(weekdays).size !== weekdays.length ||
      !weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    )
      throw new Error('Selecciona al menos un día de la semana válido.')
    const range = scheduledRange(day, draft)
    draft = {
      ...draft,
      weekdays,
      scoreTemplate: draft.scoreTemplate ?? 'work',
      hours: range?.hours ?? draft.hours,
    }
    if (!isScoreTemplate(draft.scoreTemplate))
      throw new Error('Plantilla de score inválida.')
    const old = this.find('task_templates', 'id', id)
    if (update && (!old || old.archivedOn || old.startsOn > day))
      throw new Error('La plantilla no está activa en esta fecha.')
    if (!update) {
      if (old) throw new Error('La plantilla ya existe.')
      this.put('task_templates', { id, startsOn: day, archivedOn: null })
    }
    this.remove(
      'template_versions',
      (v) => v.templateId === id && v.effectiveDay === day,
    )
    this.rows('template_versions').push({
      templateId: id,
      effectiveDay: day,
      content: JSON.stringify({ ...draft, completed: false }),
    })
    this.syncExisting(day)
    return this.active(day).find((t) => t.id === id)
  }
  applyTemplate(id: string, day: string, sourceDay: string) {
    const template = this.active(sourceDay).find((t) => t.id === id)
    if (!template) throw new Error('La plantilla no está activa.')
    let o = this.rows('template_occurrences').find(
      (o) => o.templateId === id && o.day === day,
    )
    if (o && this.find('tasks', 'id', o.taskId))
      return { taskId: o.taskId, added: false }
    if (!o) {
      o = { templateId: id, day, taskId: randomUUID() }
      this.rows('template_occurrences').push(o)
    }
    Object.assign(o, { customized: 1, suppressed: 0 })
    this.write(day, { ...template, completed: false }, o.taskId)
    return { taskId: o.taskId, added: true }
  }
  scheduledTasks(day: string) {
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Lima',
    })
    const limit = nextDay(today, 2)
    if (day <= limit) this.syncDay(day)
    for (let offset = 0; offset <= 2; offset++)
      this.syncDay(nextDay(today, offset))
    const tasks = this.tasks().filter(
      (t) =>
        !t.templateId ||
        t.day <= limit ||
        t.completed ||
        this.occurrence(t.id)?.customized,
    )
    for (const t of tasks)
      if (
        t.kind !== 'task' &&
        t.startTime &&
        t.endTime &&
        !t.calendarEventId &&
        !this.find('calendar_schedule_dirty', 'taskId', t.id)
      )
        this.queue('calendar_schedule_dirty', 'taskId', t.id)
    return tasks
  }
  importCalendar(day: string, entries: CalendarEntry[]) {
    for (const link of [...this.rows('calendar_imports')].filter(
      (l) => l.day === day,
    )) {
      if (
        !entries.some((e) => e.eventId === link.eventId) &&
        !this.find('calendar_schedule_dirty', 'taskId', link.taskId) &&
        !this.find('calendar_outbox', 'eventId', link.eventId)
      ) {
        this.noteRemoval(day, link.taskId)
        this.remove('tasks', (t) => t.id === link.taskId && !t.completed)
        if (!this.find('tasks', 'id', link.taskId))
          this.remove('calendar_imports', (l) => l.eventId === link.eventId)
      }
    }
    for (const entry of entries) {
      const link = this.find('calendar_imports', 'eventId', entry.eventId)
      const id =
        link?.taskId ??
        `gcal-${createHash('sha256').update(entry.eventId).digest('hex')}`
      const existing = this.find('tasks', 'id', id)
      if (
        this.find('calendar_schedule_dirty', 'taskId', id) ||
        existing?.kind === 'task' ||
        (link && !existing && link.day === day) ||
        this.find('calendar_outbox', 'eventId', entry.eventId)
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
      if (existing) {
        existing.day = day
        this.noteEdit(day, draft, id)
      }
      this.write(day, draft, id, Boolean(existing), true)
      this.put(
        'calendar_imports',
        { eventId: entry.eventId, taskId: id, day },
        'eventId',
      )
    }
  }
}
