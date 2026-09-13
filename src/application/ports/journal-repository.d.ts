import type {
  DailyReflection,
  Goal,
  Objective,
  Task,
  TaskDraft,
} from '../../domain/models.types.d.ts'

export type Result<T> = T | Promise<T>

export type RecordData = Record<string, unknown>

export interface TaskRepository {
  tasks(day?: string): Result<Task[]>
  saveTask(
    day: string,
    task: TaskDraft,
    id?: string,
    update?: boolean,
  ): Result<RecordData>
  saveDay(day: string, tasks: Task[]): Result<Task[]>
  deleteTask(day: string, id: string): Result<unknown>
}

export interface GoalRepository {
  saveGoal(goal: Goal, update: boolean): Result<Goal>
  saveObjective(objective: Objective, update: boolean): Result<Objective>
}

export interface TemplateRepository {
  list(day: string): Result<RecordData[]>
  save(
    draft: TaskDraft,
    day: string,
    id?: string,
    update?: boolean,
  ): Result<unknown>
  applyToDay(
    id: string,
    day: string,
    sourceDay: string,
  ): Result<{ taskId: string; added: boolean }>
  archive(id: string, day: string): Result<void>
}

export interface MoodRepository {
  list(day: string): Result<RecordData[]>
  add(day: string, score: unknown, description?: unknown): Result<RecordData>
  remove(day: string, id: string): Result<boolean>
}

export interface JournalRecordRepository {
  list(day: string): Result<RecordData[]>
  save(
    day: string,
    title: unknown,
    body: unknown,
    id?: string,
  ): Result<RecordData>
  remove(day: string, id: string): Result<boolean>
}

export interface ReflectionRepository {
  get(day: string): Result<RecordData>
  save(day: string, value: DailyReflection): Result<RecordData>
}

export interface ImageRepository {
  list(day: string): Result<RecordData[]>
  add(day: string, name: string, bytes: Uint8Array): Result<RecordData>
  get(
    day: string,
    id: string,
  ): Result<{ mimeType: string; data: Uint8Array } | undefined>
  crop(
    day: string,
    id: string,
    zoom: unknown,
    x: unknown,
    y: unknown,
  ): Result<RecordData>
  remove(day: string, id: string): Result<boolean>
}

export interface ReportRepository {
  overview(): Result<{
    goals: RecordData[]
    objectives: RecordData[]
    tasks: Task[]
  }>
  reportExtras(): Result<RecordData>
  reportEntries(start: string, end: string): Result<RecordData>
}

export interface JournalRepository
  extends TaskRepository, GoalRepository, ReportRepository {
  templates: TemplateRepository
  moods: MoodRepository
  journals: JournalRecordRepository
  reflections: ReflectionRepository
  images: ImageRepository
}
