import { mkdirSync } from 'node:fs'
import type { PersistenceProvider } from './contracts.d.ts'

export const sqliteProvider: PersistenceProvider = async (config) => {
  const { createStore } = await import('../infrastructure/sqlite/store.ts')
  const { createAuth } = await import('../infrastructure/sqlite/auth.ts')
  mkdirSync('data', { recursive: true })
  const store = createStore('data/journal.sqlite')
  try {
    const auth = createAuth(
      config,
      'data/auth.sqlite',
      fetch,
      store.importCalendar,
      store.calendarOutbox,
      store.calendarSchedule,
    )
    return { store, auth }
  } catch (error) {
    store.close()
    throw error
  }
}
