import type { Task } from './models.types.d.ts'

export type CalendarCompletion = {
  eventId: string
  day: string
  completed: number
  revision: number
}

export type CalendarSchedule = {
  tasks: (day: string) => Task[]
  link: (taskId: string, eventId: string, day: string) => void
  unlink?: (taskId: string, eventId: string) => void
  pending: () => { taskId: string; revision: number }[]
  acknowledge: (taskId: string, revision: number) => void
}

export type CalendarOutbox = {
  pending: (day?: string) => CalendarCompletion[]
  acknowledge: (change: CalendarCompletion) => void
}

export type CalendarEntry = {
  startTime?: string
  endTime?: string
  timeZone?: string
  completed?: boolean
  eventId: string
  title: string
  description: string
  hours: number
}
