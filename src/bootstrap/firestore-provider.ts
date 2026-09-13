import type { PersistenceProvider } from './contracts.d.ts'

export const firestoreProvider: PersistenceProvider = async (config) => {
  const { CloudDatabase } =
    await import('../infrastructure/firestore/database.ts')
  const { createCloudStore } =
    await import('../infrastructure/firestore/store.ts')
  const { createCloudAuth } =
    await import('../infrastructure/firestore/auth.ts')
  const db = new CloudDatabase()
  try {
    const namespace = await db.firestore.doc(`journals/${db.namespace}`).get()
    if (namespace.data()?.migrationStatus !== 'ready') {
      throw new Error(
        'Completa y verifica la migración de Firestore antes de iniciar el backend.',
      )
    }
    const store = createCloudStore(db)
    const auth = createCloudAuth(
      config,
      db,
      fetch,
      store.importCalendar,
      store.calendarOutbox,
      store.calendarSchedule,
    )
    return { store, auth }
  } catch (error) {
    await db.close()
    throw error
  }
}
