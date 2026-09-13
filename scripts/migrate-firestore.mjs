import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { existsSync } from 'node:fs'
import {
  CloudDatabase,
  keys,
  documentId,
} from '../src/infrastructure/firestore/database.ts'

if (existsSync('.env')) loadEnvFile('.env')
const args = process.argv.slice(2)
const source = resolve(
  args.find((arg) => arg.startsWith('--source='))?.slice(9) || 'data',
)
const apply = args.includes('--apply')
const verifyOnly = args.includes('--verify')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const stable = (value) => JSON.stringify(value, Object.keys(value).sort())
const tables = {}
const images = []
for (const filename of ['journal.sqlite', 'auth.sqlite']) {
  const sqlite = new DatabaseSync(resolve(source, filename), { readOnly: true })
  try {
    sqlite.exec('BEGIN')
    for (const { name } of sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()) {
      if (!keys[name]) throw new Error(`Tabla sin mapeo: ${name}`)
      // Sessions and PKCE challenges are ephemeral; require a fresh login after cutover.
      if (['auth_sessions', 'oauth_states'].includes(name)) continue
      const rows = sqlite
        .prepare(`SELECT rowid AS _order, * FROM "${name}" ORDER BY rowid`)
        .all()
      tables[name] = rows.map((row) => {
        if (name === 'entry_images') {
          const bytes = Buffer.from(row.data)
          const checksum = hash(bytes)
          delete row.data
          images.push({ id: row.id, bytes, checksum, mimeType: row.mimeType })
          row.sha256 = checksum
        }
        return row
      })
    }
    sqlite.exec('COMMIT')
  } finally {
    sqlite.close()
  }
}
for (const name of Object.keys(keys)) tables[name] ??= []
const ids = new Set(tables.tasks.map((t) => t.id))
const goals = new Set(tables.goals.map((g) => g.id))
const objectives = new Set(tables.objectives.map((o) => o.id))
if (
  tables.objectives.some((o) => !goals.has(o.goalId)) ||
  tables.tasks.some((t) => t.objectiveId && !objectives.has(t.objectiveId))
)
  throw new Error('Hay referencias inválidas en el origen.')
const namespace = process.env.JOURNAL_NAMESPACE || 'personal'
for (const image of tables.entry_images)
  image.storagePath = `journal/${namespace}/images/${image.id}`
const fingerprint = hash(
  JSON.stringify(
    Object.entries(tables)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rows]) => [name, rows.map(stable)]),
  ),
)
console.log(
  JSON.stringify(
    {
      mode: verifyOnly ? 'verify' : apply ? 'apply' : 'dry-run',
      project: process.env.GOOGLE_CLOUD_PROJECT,
      database: process.env.FIRESTORE_DATABASE || '(default)',
      bucket: process.env.STORAGE_BUCKET,
      namespace,
      sourceFingerprint: fingerprint,
      counts: Object.fromEntries(
        Object.entries(tables).map(([k, v]) => [k, v.length]),
      ),
      images: images.length,
      tasks: ids.size,
    },
    null,
    2,
  ),
)
if (!apply && !verifyOnly) {
  console.log(
    'Solo lectura local. Para copiar: --apply. Detén las escrituras locales durante la migración definitiva.',
  )
  process.exit(0)
}
const cloud = new CloudDatabase()
const marker = cloud.firestore.doc(`journals/${namespace}`)
try {
  if (!verifyOnly) {
    await cloud.firestore.runTransaction(async (tx) => {
      const current = (await tx.get(marker)).data()
      if (
        current &&
        (current.sourceFingerprint !== fingerprint ||
          current.migrationStatus === 'ready')
      )
        throw new Error(
          'Destino ocupado o migración ya completada. Usa --verify o un JOURNAL_NAMESPACE nuevo; no se sobrescribe.',
        )
      if (!current) {
        for (const name of Object.keys(keys))
          if (!(await tx.get(cloud.collection(name).limit(1))).empty)
            throw new Error(
              'Hay documentos en el destino. Usa un namespace vacío.',
            )
      }
      tx.set(marker, {
        migrationStatus: 'importing',
        sourceFingerprint: fingerprint,
        startedAt: current?.startedAt ?? new Date().toISOString(),
        revision: 0,
      })
    })
    for (const image of images) {
      const file = cloud.storage
        .bucket(cloud.bucketName)
        .file(`journal/${namespace}/images/${image.id}`)
      try {
        await file.save(image.bytes, {
          resumable: false,
          contentType: image.mimeType,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { metadata: { sha256: image.checksum } },
        })
      } catch (error) {
        if (Number(error.code) !== 412) throw error
      }
      // Verify bytes, including pre-existing objects; never trust metadata alone.
      const [bytes] = await file.download()
      if (hash(bytes) !== image.checksum)
        throw new Error('Una imagen del destino no coincide con el respaldo.')
    }
    for (const [name, rows] of Object.entries(tables))
      for (const row of rows) {
        const ref = cloud.ref(name, row)
        try {
          await ref.create(row)
        } catch (error) {
          if (Number(error.code) !== 6) throw error
          if (stable((await ref.get()).data()) !== stable(row))
            throw new Error(`Documento existente diferente en ${name}.`)
        }
      }
  }
  for (const [name, rows] of Object.entries(tables)) {
    if (['runtime_locks', 'auth_sessions', 'oauth_states'].includes(name))
      continue
    const remote = await cloud.collection(name).get()
    if (remote.size !== rows.length)
      throw new Error(`Conteo diferente en ${name}.`)
    const expected = new Map(
      rows.map((row) => [documentId(name, row), stable(row)]),
    )
    for (const doc of remote.docs)
      if (expected.get(doc.id) !== stable(doc.data()))
        throw new Error(`Contenido diferente en ${name}.`)
  }
  for (const image of images) {
    const [bytes] = await cloud.storage
      .bucket(cloud.bucketName)
      .file(`journal/${namespace}/images/${image.id}`)
      .download()
    if (hash(bytes) !== image.checksum)
      throw new Error('Checksum de imagen diferente.')
  }
  if (!verifyOnly)
    await marker.update({
      migrationStatus: 'ready',
      verifiedAt: new Date().toISOString(),
    })
  console.log(
    'Verificación completa: documentos e imágenes coinciden con el origen. SQLite no se modificó.',
  )
} finally {
  await cloud.close()
}
