import type { Query } from '@google-cloud/firestore'
import type { Filter, Selections } from './queries.d.ts'
import { Firestore } from '@google-cloud/firestore'
import { Storage } from '@google-cloud/storage'
import { createHash } from 'node:crypto'
import { localGcloudAuth } from './local-auth.ts'

// Documents retain their original fields; hashed keys also support Calendar IDs containing '/'.
import type { Row, Tables } from '../../domain/records.d.ts'

export type { Row, Tables } from '../../domain/records.d.ts'
export const keys: Record<string, string[]> = {
  goals: ['id'],
  objectives: ['id'],
  tasks: ['id'],
  mood_records: ['id'],
  journal_records: ['id'],
  daily_reflections: ['day'],
  entry_images: ['id'],
  task_templates: ['id'],
  template_versions: ['templateId', 'effectiveDay'],
  template_occurrences: ['templateId', 'day'],
  calendar_imports: ['eventId'],
  calendar_outbox: ['eventId'],
  calendar_schedule_dirty: ['taskId'],
  migrations: ['name'],
  auth_accounts: ['email'],
  calendar_account: ['id'],
  auth_owner: ['id'],
  calendar_connection: ['id'],
  calendar_published: ['taskId'],
  calendar_links: ['taskId'],
  runtime_locks: ['name'],
  auth_sessions: ['hash'],
  oauth_states: ['hash'],
}
export function documentId(table: string, row: Row) {
  if (!keys[table]) throw new Error('Unknown collection')
  return createHash('sha256')
    .update(JSON.stringify(keys[table].map((key) => row[key])))
    .digest('hex')
}

export class CloudDatabase {
  readonly firestore: Firestore
  readonly storage: Storage
  readonly bucketName: string
  readonly namespace: string
  constructor() {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT
    const bucketName = process.env.STORAGE_BUCKET
    if (!projectId || !bucketName) {
      throw new Error('Configura GOOGLE_CLOUD_PROJECT y STORAGE_BUCKET.')
    }
    const auth = localGcloudAuth(projectId)
    this.firestore = new Firestore({
      ...(auth ? { auth: auth.firestore } : {}),
      projectId,
      databaseId: process.env.FIRESTORE_DATABASE || '(default)',
    })
    this.storage = new Storage({
      projectId,
      ...(auth ? { authClient: auth.storage } : {}),
    })
    this.bucketName = bucketName
    this.namespace = process.env.JOURNAL_NAMESPACE || 'personal'
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(this.namespace))
      throw new Error('Invalid JOURNAL_NAMESPACE')
  }
  collection(table: string) {
    if (!keys[table]) throw new Error('Unknown collection')
    return this.firestore.collection(`journals/${this.namespace}/${table}`)
  }
  query(table: string, filters: Filter[] = []): Query {
    return filters.reduce<Query>(
      (query, filter) => query.where(filter.field, filter.op, filter.value),
      this.collection(table),
    )
  }
  async all(table: string, filters: Filter[] = []): Promise<Row[]> {
    return (await this.query(table, filters).get()).docs
      .map((doc) => doc.data())
      .sort((a, b) => (a._order || 0) - (b._order || 0))
  }
  ref(table: string, key: Row) {
    return this.collection(table).doc(documentId(table, key))
  }
  async get(table: string, key: Row) {
    return (await this.ref(table, key).get()).data()
  }
  async set(table: string, row: Row) {
    await this.ref(table, row).set(row)
  }
  async remove(table: string, key: Row) {
    await this.ref(table, key).delete()
  }
  async change(
    table: string,
    key: Row,
    change: (row: Row | undefined) => Row | undefined,
  ) {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.ref(table, key)
      const before = (await tx.get(ref)).data()
      const after = change(before)
      if (after) tx.set(ref, after)
      else if (before) tx.delete(ref)
      return after
    })
  }
  async consume(table: string, key: Row) {
    return this.firestore.runTransaction(async (tx) => {
      const ref = this.ref(table, key)
      const value = (await tx.get(ref)).data()
      if (value) tx.delete(ref)
      return value
    })
  }
  // Domain operations read first, then commit only changed documents atomically.
  // The namespace revision also detects concurrent inserts into a query.
  async read<T>(names: string[], action: (tables: Tables) => T): Promise<T> {
    return this.firestore.runTransaction(
      async (tx) => {
        const snapshots = await Promise.all(
          names.map((name) => tx.get(this.collection(name))),
        )
        const tables: Tables = {}
        snapshots.forEach((snapshot, index) => {
          tables[names[index]] = snapshot.docs
            .map((doc) => doc.data())
            .sort((a, b) => (a._order || 0) - (b._order || 0))
        })
        return action(tables)
      },
      { readOnly: true },
    )
  }
  async run<T>(
    names: string[],
    action: (tables: Tables) => T,
    selections: Selections = {},
  ): Promise<T> {
    return this.firestore.runTransaction(async (tx) => {
      const revision = this.firestore.doc(`journals/${this.namespace}`)
      const marker = await tx.get(revision)
      const tables: Tables = {}
      const originals: Record<string, Map<string, string>> = {}
      const snapshots = await Promise.all(
        names.map(async (name) => {
          const groups = selections[name] ?? [[]]
          const results = await Promise.all(
            groups.map((filters) => tx.get(this.query(name, filters))),
          )
          const documents = new Map(
            results.flatMap((result) =>
              result.docs.map((doc) => [doc.id, doc] as const),
            ),
          )
          return { docs: [...documents.values()] }
        }),
      )
      for (const [index, name] of names.entries()) {
        const snapshot = snapshots[index]
        tables[name] = snapshot.docs
          .map((doc) => doc.data())
          .sort((a, b) => (a._order || 0) - (b._order || 0))
        originals[name] = new Map(
          snapshot.docs.map((doc) => [doc.id, JSON.stringify(doc.data())]),
        )
      }
      const result = action(tables)
      let writes = 0
      for (const name of names) {
        const retained = new Set<string>()
        for (const row of tables[name]) {
          const id = documentId(name, row)
          if (retained.has(id)) throw new Error('Registro duplicado.')
          retained.add(id)
          if (originals[name].get(id) !== JSON.stringify(row)) {
            tx.set(this.collection(name).doc(id), row)
            writes++
          }
        }
        for (const id of originals[name].keys())
          if (!retained.has(id)) {
            tx.delete(this.collection(name).doc(id))
            writes++
          }
      }
      if (writes > 450)
        throw new Error(
          'Demasiados cambios en una operación. Divide la actualización en períodos menores.',
        )
      if (writes)
        tx.set(
          revision,
          { revision: Number(marker.data()?.revision || 0) + 1 },
          { merge: true },
        )
      return result
    })
  }
  async exclusive<T>(name: string, action: () => Promise<T>) {
    const owner = crypto.randomUUID()
    const acquire = (existing: Row | undefined) => {
      if (
        existing &&
        existing.owner !== owner &&
        existing.expires > Date.now()
      ) {
        throw new Error(
          'Calendar está sincronizando. Vuelve a intentar en unos segundos.',
        )
      }
      return { name, owner, expires: Date.now() + 60_000 }
    }
    await this.change('runtime_locks', { name }, acquire)
    let lost = false
    const timer = setInterval(() => {
      void this.change('runtime_locks', { name }, acquire).catch(() => {
        lost = true
      })
    }, 20_000)
    try {
      const result = await action()
      if (lost)
        throw new Error(
          'La sincronización perdió su bloqueo. Reintenta para comprobar los cambios.',
        )
      return result
    } finally {
      clearInterval(timer)
      await this.change('runtime_locks', { name }, (row) =>
        row?.owner === owner ? undefined : row,
      )
    }
  }
  async close() {
    await this.firestore.terminate()
  }
}
