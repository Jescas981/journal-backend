import type {
  JournalRepository,
  Result,
} from '../application/ports/journal-repository.d.ts'

import type { IncomingMessage, ServerResponse } from 'node:http'

export type AuthConfig = {
  clientId: string
  clientSecret: string
  allowedEmail: string
  tokenKey?: string
  origin: string
}

export interface Authentication {
  middleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void>
  close(): void
}

export interface RuntimeDependencies {
  store: JournalRepository & { close(): Result<void> }
  auth: Authentication
}

export type PersistenceProvider = (
  config: AuthConfig,
) => Promise<RuntimeDependencies>
