import type { Overview } from './models.types.d.ts'

export type ReportPeriod = 'week' | 'month' | 'year' | 'all'

export type ReportData = Overview & {
  moods: { day: string; score: number }[]
  journalDays: string[]
  imageDays: string[]
  reflectionDays: string[]
}
