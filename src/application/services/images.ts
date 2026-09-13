import { cropInput } from '../../domain/entry-validation.ts'
import type { ImageRepository } from '../ports/journal-repository.d.ts'

import { checkDay, object } from '../../domain/validation.ts'
import { NotFoundError } from '../errors.ts'

export function createImageService(repository: ImageRepository) {
  return {
    list(day: string) {
      checkDay(day)
      return repository.list(day)
    },
    async get(day: string, id: string) {
      checkDay(day)
      const image = await repository.get(day, id)
      if (!image) throw new NotFoundError('La imagen no existe en este día.')
      return image
    },
    add(day: string, name: string, bytes: Uint8Array) {
      checkDay(day)
      return repository.add(day, name, bytes)
    },
    crop(day: string, id: string, value: unknown) {
      checkDay(day)
      const body = object(value)
      const crop = cropInput(body.cropZoom, body.cropX, body.cropY)
      return repository.crop(day, id, crop.cropZoom, crop.cropX, crop.cropY)
    },
    async remove(day: string, id: string) {
      checkDay(day)
      if (!id || !(await repository.remove(day, id)))
        throw new NotFoundError('La imagen no existe en este día.')
    },
  }
}
