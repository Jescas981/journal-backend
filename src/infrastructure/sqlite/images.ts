import type { DatabaseSync } from 'node:sqlite'
import { cropInput } from '../../domain/entry-validation.ts'
import type { EntryImage } from '../../domain/models.types.d.ts'

import { validDay } from '../../domain/dates.ts'

import { MAX_IMAGE_BYTES, imageType } from '../../domain/images.ts'

export function createImageStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entry_images (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      name TEXT NOT NULL,
      mimeType TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploadedAt TEXT NOT NULL,
      data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_images_day_time ON entry_images(day, uploadedAt);
  `)
  const columns = db
    .prepare('PRAGMA table_info(entry_images)')
    .all()
    .map((column) => column.name)
  for (const [name, initial] of [
    ['cropZoom', 0],
    ['cropX', 50],
    ['cropY', 50],
  ] as const) {
    if (!columns.includes(name))
      db.exec(
        `ALTER TABLE entry_images ADD COLUMN ${name} REAL NOT NULL DEFAULT ${initial}`,
      )
  }
  const metadata =
    'id, day, name, mimeType, size, uploadedAt, cropZoom, cropX, cropY'
  function checkDay(day: string) {
    if (!validDay(day)) throw new Error('Selecciona una fecha válida.')
  }

  return {
    crop: (
      day: string,
      id: string,
      zoom: unknown,
      x: unknown,
      y: unknown,
    ): EntryImage => {
      checkDay(day)
      cropInput(zoom, x, y)
      if (
        !db
          .prepare(
            'UPDATE entry_images SET cropZoom=?, cropX=?, cropY=? WHERE id=? AND day=?',
          )
          .run(Number(zoom), Number(x), Number(y), id, day).changes
      )
        throw new Error('La imagen no existe en este día.')
      return db
        .prepare(`SELECT ${metadata} FROM entry_images WHERE id=? AND day=?`)
        .get(id, day) as EntryImage
    },
    list: (day: string): EntryImage[] => {
      checkDay(day)
      return db
        .prepare(
          `SELECT ${metadata} FROM entry_images WHERE day = ? ORDER BY uploadedAt DESC, rowid DESC`,
        )
        .all(day) as EntryImage[]
    },
    add: (day: string, name: string, bytes: Uint8Array): EntryImage => {
      checkDay(day)
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
        throw new Error('La imagen debe pesar como máximo 5 MB.')
      const image = {
        cropZoom: 0,
        cropX: 50,
        cropY: 50,
        id: crypto.randomUUID(),
        day,
        name: name.trim().slice(0, 255) || 'Imagen del día',
        mimeType: imageType(bytes),
        size: bytes.length,
        uploadedAt: new Date().toISOString(),
      }
      db.prepare(
        'INSERT INTO entry_images (id, day, name, mimeType, size, uploadedAt, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        image.id,
        day,
        image.name,
        image.mimeType,
        image.size,
        image.uploadedAt,
        bytes,
      )
      return image
    },
    get: (day: string, id: string) => {
      checkDay(day)
      return db
        .prepare(
          'SELECT mimeType, data FROM entry_images WHERE id = ? AND day = ?',
        )
        .get(id, day) as { mimeType: string; data: Uint8Array } | undefined
    },
    remove: (day: string, id: string) => {
      checkDay(day)
      return (
        db
          .prepare('DELETE FROM entry_images WHERE id = ? AND day = ?')
          .run(id, day).changes > 0
      )
    },
  }
}
