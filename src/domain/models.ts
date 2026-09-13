import type {
  DailyReflection,
  Objective,
  ScoreTemplate,
  Task,
  TaskDraft,
} from './models.types.d.ts'
export const scoreTemplates = {
  work: {
    label: '🎯 Trabajo / estudio',
    factors: ['Importancia', 'Foco', 'Impacto'],
  },
  recovery: {
    label: '🌿 Recuperación',
    factors: ['Intencionalidad', 'Recuperación', 'Satisfacción'],
  },
  personal: {
    label: '❤️ Vida personal/social',
    factors: ['Importancia personal', 'Presencia', 'Satisfacción'],
  },
} as const

export function isScoreTemplate(value: unknown): value is ScoreTemplate {
  return typeof value === 'string' && Object.hasOwn(scoreTemplates, value)
}

export const weekDays = [
  { value: 1, label: 'Lun' },
  { value: 2, label: 'Mar' },
  { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' },
  { value: 5, label: 'Vie' },
  { value: 6, label: 'Sáb' },
  { value: 0, label: 'Dom' },
] as const
export const everyDay = weekDays.map((day) => day.value)

export const emptyTask: TaskDraft = {
  kind: 'event',
  title: '',
  description: '',
  startTime: null,
  endTime: null,
  timeZone: null,
  completed: false,
  milestone: false,
  objectiveId: null,
  scoreTemplate: 'work',
  importance: 0,
  hours: 0,
  depth: 0,
  impact: 0,
}

export const FACTOR_MAX = 10

export function isQualityFactor(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= FACTOR_MAX
  )
}

export function qualityHours(task: TaskDraft): number {
  if (task.kind === 'task') return 0
  const normalizedAverage =
    (task.importance + task.depth + task.impact) / (3 * FACTOR_MAX)
  return task.hours * normalizedAverage
}

export function objectiveProgress(objective: Objective, tasks: Task[]) {
  const linked = tasks.filter((task) => task.objectiveId === objective.id)
  const completed = linked.filter((task) => task.completed)
  const earned = completed.reduce(
    (total, task) => total + qualityHours(task),
    0,
  )
  return {
    total: linked.length,
    completed: completed.length,
    earned,
    percent: objective.targetHours
      ? Math.min(100, (earned / objective.targetHours) * 100)
      : null,
  }
}

export const emptyReflection: DailyReflection = {
  undone: '',
  frequentProblem: '',
  mainProblem: '',
  discomforts: '',
  actions: '',
  description: '',
  gratitude: '',
  rating: null,
}
