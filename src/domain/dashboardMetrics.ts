import type { Period } from './dashboardMetrics.types.d.ts'
import { dateKey } from './dates.ts'
import { qualityHours } from './models.ts'
import type { Overview } from './models.types.d.ts'

export function periodRange(anchor: string, period: Period) {
  const start = new Date(`${anchor}T12:00:00`)
  if (period === 'week') {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  } else {
    start.setDate(1)
  }
  const end = new Date(start)
  if (period === 'week') end.setDate(end.getDate() + 6)
  else end.setMonth(end.getMonth() + 1, 0)
  return { start: dateKey(start), end: dateKey(end) }
}

export function movePeriod(anchor: string, period: Period, direction: number) {
  const range = periodRange(anchor, period)
  const date = new Date(`${range.start}T12:00:00`)
  if (period === 'week') date.setDate(date.getDate() + direction * 7)
  else date.setMonth(date.getMonth() + direction)
  return dateKey(date)
}

export function dashboardMetrics(data: Overview, start: string, end: string) {
  const totals = new Map<string, { period: number; lifetime: number }>()
  for (const objective of data.objectives)
    totals.set(objective.id, { period: 0, lifetime: 0 })
  let unassigned = 0
  let completed = 0
  for (const task of data.tasks) {
    if (!task.completed) continue
    const hours = qualityHours(task)
    const inPeriod = task.day >= start && task.day <= end
    if (inPeriod) completed++
    const total = task.objectiveId ? totals.get(task.objectiveId) : undefined
    if (total) {
      total.lifetime += hours
      if (inPeriod) total.period += hours
    } else if (inPeriod) unassigned += hours
  }
  const rows = data.objectives.map((objective) => ({
    id: objective.id,
    title: objective.title,
    goal: data.goals.find((goal) => goal.id === objective.goalId),
    ...totals.get(objective.id)!,
  }))
  return {
    rows,
    completed,
    unassigned,
    periodTotal: rows.reduce((sum, row) => sum + row.period, 0),
    lifetimeTotal: rows.reduce((sum, row) => sum + row.lifetime, 0),
  }
}

export function dailyQualityMetrics(
  data: Overview,
  start: string,
  end: string,
) {
  const objectiveIds = new Set(data.objectives.map((objective) => objective.id))
  const days = new Map<
    string,
    { day: string; total: number; values: Map<string | null, number> }
  >()
  const cursor = new Date(`${start}T12:00:00`)
  while (dateKey(cursor) <= end) {
    const day = dateKey(cursor)
    days.set(day, { day, total: 0, values: new Map() })
    cursor.setDate(cursor.getDate() + 1)
  }

  let hasUnassigned = false
  for (const task of data.tasks) {
    const day = days.get(task.day)
    if (!day || !task.completed) continue
    const value = qualityHours(task)
    const objectiveId =
      task.objectiveId && objectiveIds.has(task.objectiveId)
        ? task.objectiveId
        : null
    day.total += value
    day.values.set(objectiveId, (day.values.get(objectiveId) ?? 0) + value)
    if (objectiveId === null && value > 0) hasUnassigned = true
  }

  const series: { id: string | null; title: string; context: string }[] =
    data.objectives.map((objective) => {
      const goal = data.goals.find((goal) => goal.id === objective.goalId)
      return {
        id: objective.id,
        title: objective.title,
        context: goal ? `${goal.title} · ${goal.year}` : '',
      }
    })
  if (hasUnassigned)
    series.push({ id: null, title: 'Sin objetivo', context: '' })

  return {
    series,
    days: [...days.values()].map((day) => ({
      day: day.day,
      total: day.total,
      values: series.map((item) => day.values.get(item.id) ?? 0),
    })),
  }
}
