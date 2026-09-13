import { randomUUID } from 'node:crypto'
import type { TaskRepository } from '../ports/journal-repository.d.ts'

import {
  checkDay,
  dayTasks,
  object,
  taskDraft,
} from '../../domain/validation.ts'

export function createTaskService(repository: TaskRepository) {
  return {
    list(day: string) {
      checkDay(day)
      return repository.tasks(day)
    },
    save(day: string, value: unknown, id: string, update: boolean) {
      checkDay(day)
      const draft = taskDraft(value)
      if (update && !id) throw new Error('Falta el identificador.')
      return repository.saveTask(day, draft, update ? id : randomUUID(), update)
    },
    saveEntry(day: string, value: unknown) {
      checkDay(day)
      return repository.saveDay(day, dayTasks(object(value).tasks))
    },
    remove(day: string, id: string) {
      checkDay(day)
      return repository.deleteTask(day, id)
    },
  }
}
