import type { AuthConfig, PersistenceProvider } from './contracts.d.ts'

import { firestoreProvider } from './firestore-provider.ts'
import { sqliteProvider } from './sqlite-provider.ts'

const providers: Readonly<Record<string, PersistenceProvider>> = {
  sqlite: sqliteProvider,
  firestore: firestoreProvider,
}

// Only this composition boundary selects concrete infrastructure.
// Tests can inject a provider registry without opening a database or contacting Google.
export async function createPersistence(
  backend: string,
  config: AuthConfig,
  registry: Readonly<Record<string, PersistenceProvider>> = providers,
) {
  if (!Object.hasOwn(registry, backend))
    throw new Error('DATA_BACKEND no válido.')
  return registry[backend](config)
}
