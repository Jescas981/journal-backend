import { randomUUID } from 'node:crypto'
import type { GoalRepository } from '../ports/journal-repository.d.ts'

import { numberValid, object, titleValid } from '../../domain/validation.ts'

export function createGoalService(repository: GoalRepository) {
  function draft(value: unknown, id: string, update: boolean) {
    const body = object(value)
    if (!titleValid(body.title))
      throw new Error('El título es obligatorio (máximo 200 caracteres).')
    if (update && !id) throw new Error('Falta el identificador.')
    return { body, id: update ? id : randomUUID(), title: body.title.trim() }
  }
  return {
    saveGoal(value: unknown, id: string, update: boolean) {
      const input = draft(value, id, update)
      const year = input.body.year
      if (
        typeof year !== 'number' ||
        !Number.isInteger(year) ||
        year < 100 ||
        year > 9999
      ) {
        throw new Error('El año no es válido.')
      }
      return repository.saveGoal(
        { id: input.id, title: input.title, year },
        update,
      )
    },
    saveObjective(value: unknown, id: string, update: boolean) {
      const input = draft(value, id, update)
      const { goalId, targetHours } = input.body
      if (
        typeof goalId !== 'string' ||
        !(targetHours === null || (numberValid(targetHours) && targetHours > 0))
      ) {
        throw new Error(
          'Selecciona una meta y un objetivo de horas mayor que cero, o déjalo vacío.',
        )
      }
      return repository.saveObjective(
        { id: input.id, title: input.title, goalId, targetHours },
        update,
      )
    },
  }
}
