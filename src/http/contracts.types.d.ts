import type { IncomingMessage, ServerResponse } from 'node:http'

export type Context = {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  day: string
  id: string
  json: (limit?: number) => Promise<unknown>
  send: (status: number, body: unknown) => void
}

export type Handler = (context: Context) => void | Promise<void>

export type Route = {
  day?: boolean
  methods: Partial<Record<'GET' | 'POST' | 'PUT' | 'DELETE', Handler>>
}

export type Routes = Record<string, Route>
