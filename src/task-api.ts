// Compatibility entry point for existing API integrations.
import type { JournalRepository } from './application/ports/journal-repository.d.ts'

import { createServices } from './application/create-services.ts'
import { createRouter } from './http/router.ts'

export function createTaskApi(
  repository: JournalRepository,
  appOrigin = 'http://localhost:5173',
) {
  return createRouter(createServices(repository), appOrigin)
}
