import type {
  JournalRecordRepository,
  MoodRepository,
  ReflectionRepository,
} from '../ports/journal-repository.d.ts'

import {
  journalInput,
  moodInput,
  reflectionInput,
} from '../../domain/entry-validation.ts'
import { checkDay, object } from '../../domain/validation.ts'
import { NotFoundError } from '../errors.ts'

export function createJournalService(repository: JournalRecordRepository) {
  return {
    list(day: string) {
      checkDay(day)
      return repository.list(day)
    },
    save(day: string, value: unknown, id: string, update: boolean) {
      checkDay(day)
      if (update && !id) throw new Error('Falta el identificador del journal.')
      const body = object(value)
      const input = journalInput(body.title, body.body)
      return repository.save(
        day,
        input.title,
        input.body,
        update ? id : undefined,
      )
    },
    async remove(day: string, id: string) {
      checkDay(day)
      if (!id || !(await repository.remove(day, id)))
        throw new NotFoundError('El journal no existe en este día.')
    },
  }
}
export function createMoodService(repository: MoodRepository) {
  return {
    list(day: string) {
      checkDay(day)
      return repository.list(day)
    },
    add(day: string, value: unknown) {
      checkDay(day)
      const body = object(value)
      const input = moodInput(body.score, body.description)
      return repository.add(day, input.score, input.description)
    },
    async remove(day: string, id: string) {
      checkDay(day)
      if (!id || !(await repository.remove(day, id)))
        throw new NotFoundError('El registro no existe en este día.')
    },
  }
}
export function createReflectionService(repository: ReflectionRepository) {
  return {
    get(day: string) {
      checkDay(day)
      return repository.get(day)
    },
    save(day: string, value: unknown) {
      checkDay(day)
      return repository.save(day, reflectionInput(value))
    },
  }
}
