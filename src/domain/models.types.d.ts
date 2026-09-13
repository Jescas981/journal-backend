import type { scoreTemplates } from './models.ts'

export type ScoreTemplate = keyof typeof scoreTemplates

export type EntryImage = {
  cropZoom: number
  cropX: number
  cropY: number
  id: string
  day: string
  name: string
  mimeType: string
  size: number
  uploadedAt: string
}

export type JournalRecord = {
  id: string
  day: string
  title: string
  body: string
  createdAt: string
  updatedAt: string
}

export type MoodRecord = {
  id: string
  day: string
  score: number
  description: string
  recordedAt: string
}

export type Task = {
  kind: 'event' | 'task'
  weekdays?: number[]
  startTime?: string | null
  endTime?: string | null
  timeZone?: string | null
  calendarEventId?: string | null
  id: string
  templateId?: string | null
  day: string
  title: string
  description: string
  completed: boolean
  milestone: boolean
  objectiveId: string | null
  scoreTemplate: ScoreTemplate
  importance: number
  hours: number
  depth: number
  impact: number
}

export type TaskDraft = Omit<
  Task,
  'id' | 'day' | 'templateId' | 'calendarEventId'
>

export type TaskTemplate = Omit<TaskDraft, 'completed'> & {
  id: string
  startsOn: string
}

export type Goal = {
  id: string
  title: string
  year: number
}

export type Objective = {
  id: string
  goalId: string
  title: string
  targetHours: number | null
}

export type Overview = {
  goals: Goal[]
  objectives: Objective[]
  tasks: Task[]
}

export type DailyReflection = {
  undone: string
  frequentProblem: string
  mainProblem: string
  discomforts: string
  actions: string
  description: string
  gratitude: string
  rating: number | null
}
