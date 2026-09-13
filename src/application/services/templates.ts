import { randomUUID } from 'node:crypto'
import type { TemplateRepository } from '../ports/journal-repository.d.ts'

import { validDay } from '../../domain/dates.ts'
import { checkDay, object, taskDraft } from '../../domain/validation.ts'

export function createTemplateService(repository: TemplateRepository) {
  return {
    list(day: string) {
      checkDay(day)
      return repository.list(day)
    },
    save(day: string, value: unknown, id: string, update: boolean) {
      checkDay(day)
      const draft = taskDraft(value)
      if (update && !id) throw new Error('Falta el identificador.')
      return repository.save(
        { ...draft, completed: false },
        day,
        update ? id : randomUUID(),
        update,
      )
    },
    apply(day: string, id: string, value: unknown) {
      checkDay(day)
      const { sourceDay } = object(value)
      if (!id || typeof sourceDay !== 'string' || !validDay(sourceDay)) {
        throw new Error('Selecciona una plantilla y una fecha válidas.')
      }
      return repository.applyToDay(id, day, sourceDay)
    },
    archive(day: string, id: string) {
      checkDay(day)
      return repository.archive(id, day)
    },
  }
}
