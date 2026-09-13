import { periodRange } from './dashboardMetrics.ts'
import { dateKey } from './dates.ts'
import { qualityHours } from './models.ts'
import type { ReportData, ReportPeriod } from './reportMetrics.types.d.ts'

export function reportMetrics(
  data: ReportData,
  period: ReportPeriod,
  anchor: string,
  today: string,
) {
  const recordedDays = [
    ...data.tasks.map((task) => task.day),
    ...data.moods.map((mood) => mood.day),
    ...data.journalDays,
    ...data.imageDays,
    ...data.reflectionDays,
  ]
    .filter((day) => day <= today)
    .sort()
  const range =
    period === 'all'
      ? { start: recordedDays[0] ?? today, end: today }
      : period === 'year'
        ? {
            start: `${anchor.slice(0, 4)}-01-01`,
            end: `${anchor.slice(0, 4)}-12-31`,
          }
        : periodRange(anchor, period)
  const cutoff = range.end < today ? range.end : today
  const includes = (day: string) => day >= range.start && day <= cutoff
  const tasks = data.tasks.filter((task) => includes(task.day))
  const completed = tasks.filter((task) => task.completed)
  const totalQuality = completed.reduce(
    (sum, task) => sum + qualityHours(task),
    0,
  )
  const rows = data.objectives.map((objective) => {
    const linked = tasks.filter((task) => task.objectiveId === objective.id)
    const done = linked.filter((task) => task.completed)
    const quality = done.reduce((sum, task) => sum + qualityHours(task), 0)
    const accumulated = data.tasks
      .filter(
        (task) =>
          task.completed &&
          task.objectiveId === objective.id &&
          task.day <= cutoff,
      )
      .reduce((sum, task) => sum + qualityHours(task), 0)
    return {
      ...objective,
      goal: data.goals.find((goal) => goal.id === objective.goalId),
      total: linked.length,
      completed: done.length,
      quality,
      accumulated,
      percent: objective.targetHours
        ? Math.min(100, (accumulated / objective.targetHours) * 100)
        : null,
    }
  })
  const buckets = new Map<string, number>()
  const cursor = new Date(`${range.start}T12:00:00`)
  while (dateKey(cursor) <= cutoff) {
    const key =
      period === 'all'
        ? dateKey(cursor).slice(0, 4)
        : period === 'year'
          ? dateKey(cursor).slice(0, 7)
          : dateKey(cursor)
    buckets.set(key, 0)
    if (period === 'all') cursor.setFullYear(cursor.getFullYear() + 1, 0, 1)
    else if (period === 'year') cursor.setMonth(cursor.getMonth() + 1, 1)
    else cursor.setDate(cursor.getDate() + 1)
  }
  for (const task of completed) {
    const key =
      period === 'all'
        ? task.day.slice(0, 4)
        : period === 'year'
          ? task.day.slice(0, 7)
          : task.day
    buckets.set(key, (buckets.get(key) ?? 0) + qualityHours(task))
  }
  const moods = data.moods.filter((mood) => includes(mood.day))
  return {
    range,
    cutoff,
    rows,
    total: tasks.length,
    completed: completed.length,
    checklistCompleted: completed.filter((task) => task.kind === 'task').length,
    quality: totalQuality,
    eventHours: completed
      .filter((task) => task.kind !== 'task')
      .reduce((sum, task) => sum + task.hours, 0),
    milestones: completed.filter((task) => task.milestone).length,
    activeDays: new Set(completed.map((task) => task.day)).size,
    journals: data.journalDays.filter(includes).length,
    images: data.imageDays.filter(includes).length,
    reflections: data.reflectionDays.filter(includes).length,
    moodCount: moods.length,
    moodAverage: moods.length
      ? moods.reduce((sum, mood) => sum + mood.score, 0) / moods.length
      : null,
    unassigned: completed
      .filter(
        (task) =>
          !data.objectives.some(
            (objective) => objective.id === task.objectiveId,
          ),
      )
      .reduce((sum, task) => sum + qualityHours(task), 0),
    buckets: [...buckets].map(([label, value]) => ({ label, value })),
  }
}
