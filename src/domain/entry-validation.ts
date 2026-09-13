import { emptyReflection } from './models.ts'
import type { DailyReflection } from './models.types.d.ts'
import { object } from './validation.ts'

export function moodInput(score: unknown, description: unknown = '') {
  if (
    typeof score !== 'number' ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 10
  ) {
    throw new Error('Elige un estado de ánimo entero entre 0 y 10.')
  }
  if (typeof description !== 'string' || description.length > 2000) {
    throw new Error('Escribe una descripción de hasta 2000 caracteres.')
  }
  return { score, description: description.trim() }
}
export function journalInput(
  title: unknown,
  body: unknown,
  maxLength = 100_000,
) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200) {
    throw new Error('Escribe un título de hasta 200 caracteres.')
  }
  if (typeof body !== 'string' || !body.trim() || body.length > maxLength) {
    throw new Error('Escribe una reflexión de hasta 100.000 caracteres.')
  }
  return { title: title.trim(), body }
}
export function reflectionInput(value: unknown): DailyReflection {
  const input = object(value)
  const keys = Object.keys(emptyReflection).filter((key) => key !== 'rating')
  if (
    !keys.every(
      (key) => typeof input[key] === 'string' && input[key].length <= 2000,
    )
  ) {
    throw new Error('Cada respuesta admite hasta 2.000 caracteres.')
  }
  if (
    input.rating !== null &&
    (typeof input.rating !== 'number' ||
      !Number.isInteger(input.rating) ||
      input.rating < 0 ||
      input.rating > 10)
  ) {
    throw new Error('La calificación debe estar entre 0 y 10.')
  }
  return Object.fromEntries(
    Object.keys(emptyReflection).map((key) => [key, input[key]]),
  ) as DailyReflection
}
export function cropInput(zoom: unknown, x: unknown, y: unknown) {
  if (
    ![zoom, x, y].every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    ) ||
    !(zoom === 0 || (Number(zoom) >= 1 && Number(zoom) <= 3)) ||
    Number(x) < 0 ||
    Number(x) > 100 ||
    Number(y) < 0 ||
    Number(y) > 100
  ) {
    throw new Error('El recorte no es válido.')
  }
  return { cropZoom: Number(zoom), cropX: Number(x), cropY: Number(y) }
}
