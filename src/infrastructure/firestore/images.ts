import { randomUUID } from 'node:crypto'
import { cropInput } from '../../domain/entry-validation.ts'
import { imageType, MAX_IMAGE_BYTES } from '../../domain/images.ts'
import { checkDay } from '../../domain/validation.ts'
import type { CloudDatabase } from './database.ts'
import { clean, createRecordAccess } from './records.ts'

export function createImagesRepository(db: CloudDatabase) {
  const { list, remove } = createRecordAccess(db)
  return {
    list: (day: string) => list('entry_images', day),
    add: async (day: string, name: string, bytes: Uint8Array) => {
      checkDay(day)
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
        throw new Error('La imagen debe pesar como máximo 5 MB.')
      const id = randomUUID()
      const record = {
        id,
        day,
        name: name.trim().slice(0, 255) || 'Imagen del día',
        mimeType: imageType(bytes),
        size: bytes.length,
        uploadedAt: new Date().toISOString(),
        cropZoom: 0,
        cropX: 50,
        cropY: 50,
        storagePath: `journal/${db.namespace}/images/${id}`,
        _order: Date.now(),
      }
      await db.storage
        .bucket(db.bucketName)
        .file(record.storagePath)
        .save(Buffer.from(bytes), {
          resumable: false,
          contentType: record.mimeType,
          preconditionOpts: { ifGenerationMatch: 0 },
        })
      // On an uncertain Firestore failure keep the object: retry/cleanup can recover it.
      await db.run(['entry_images'], (t) => {
        t.entry_images.push(record)
      })
      return clean(record)
    },
    get: async (day: string, id: string) => {
      checkDay(day)
      const record = await db.get('entry_images', { id })
      if (!record || record.day !== day) return undefined
      const [data] = await db.storage
        .bucket(db.bucketName)
        .file(record.storagePath)
        .download()
      return { mimeType: record.mimeType as string, data }
    },
    crop: (day: string, id: string, zoom: unknown, x: unknown, y: unknown) => {
      checkDay(day)
      cropInput(zoom, x, y)
      return db.run(['entry_images'], (t) => {
        const row = t.entry_images.find((r) => r.id === id && r.day === day)
        if (!row) throw new Error('La imagen no existe en este día.')
        Object.assign(row, { cropZoom: zoom, cropX: x, cropY: y })
        return clean(row)
      })
    },
    remove: async (day: string, id: string) => {
      checkDay(day)
      const record = await db.get('entry_images', { id })
      if (!record || record.day !== day) return false
      await remove('entry_images', day, id)
      await db.storage
        .bucket(db.bucketName)
        .file(record.storagePath)
        .delete({ ignoreNotFound: true })
      return true
    },
  }
}
