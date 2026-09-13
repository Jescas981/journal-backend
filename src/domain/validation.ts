import { validDay } from './dates.ts'
import { emptyTask, isQualityFactor, isScoreTemplate } from './models.ts'
import type { Task, TaskDraft } from './models.types.d.ts'

export function checkDay(day: string) {
  if (!validDay(day)) throw new Error('Selecciona una fecha válida.')
}
export function titleValid(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= 200
  )
}
export function numberValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function taskDraft(value: unknown): TaskDraft {
  const body = object(value)
  if (!titleValid(body.title))
    throw new Error('El título es obligatorio (máximo 200 caracteres).')
  const task = { ...emptyTask, ...body }
  if (
    typeof task.description !== 'string' ||
    task.description.length > 5000 ||
    typeof task.completed !== 'boolean' ||
    typeof task.milestone !== 'boolean' ||
    ![task.importance, task.depth, task.impact].every(isQualityFactor) ||
    !isScoreTemplate(task.scoreTemplate) ||
    !numberValid(task.hours) ||
    !(task.objectiveId === null || typeof task.objectiveId === 'string')
  ) {
    throw new Error(
      'Revisa los valores: horas ≥ 0; los tres factores entre 0 y 10 y una plantilla de score válida.',
    )
  }
  return task
}
export function dayTasks(value: unknown): Task[] {
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    !value.every((item) => {
      const task = object(item)
      return (
        typeof task.id === 'string' &&
        task.id.length > 0 &&
        task.id.length <= 100 &&
        titleValid(task.title) &&
        typeof task.description === 'string' &&
        task.description.length <= 5000 &&
        typeof task.completed === 'boolean' &&
        typeof task.milestone === 'boolean' &&
        [task.importance, task.depth, task.impact].every(isQualityFactor) &&
        (task.scoreTemplate === undefined ||
          isScoreTemplate(task.scoreTemplate)) &&
        numberValid(task.hours) &&
        (task.objectiveId === null || typeof task.objectiveId === 'string')
      )
    }) ||
    new Set(value.map((task) => task.id)).size !== value.length
  ) {
    throw new Error(
      'Revisa los títulos y los valores de las tareas (máximo 200 por hoja).',
    )
  }
  return value as Task[]
}
