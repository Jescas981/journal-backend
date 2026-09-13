import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Services } from '../application/create-services.types.d.ts'

import { NotFoundError } from '../application/errors.ts'
import { checkDay } from '../domain/validation.ts'
import { readJson } from './body.ts'
import { HttpError } from './contracts.ts'
import type { Route } from './contracts.types.d.ts'
import { entryRoutes } from './controllers/entries.ts'
import { goalRoutes } from './controllers/goals.ts'
import { imageRoutes } from './controllers/images.ts'
import { reportRoutes } from './controllers/reports.ts'
import { taskRoutes } from './controllers/tasks.ts'
import { templateRoutes } from './controllers/templates.ts'

export function createRouter(services: Services) {
  const routes = {
    ...taskRoutes(services.tasks),
    ...goalRoutes(services.goals),
    ...templateRoutes(services.templates),
    ...entryRoutes(services),
    ...imageRoutes(services.images),
    ...reportRoutes(services.reports),
  }
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!Object.hasOwn(routes, url.pathname)) return next()
    const route = routes[url.pathname]
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const day = url.searchParams.get('day') ?? ''
      const id = url.searchParams.get('id') ?? ''
      if (route.day) checkDay(day)
      if (req.method !== 'GET' && req.headers.origin) {
        let sameOrigin = false
        try {
          sameOrigin = new URL(req.headers.origin).host === req.headers.host
        } catch {
          /* Invalid origin is rejected. */
        }
        if (!sameOrigin) throw new HttpError(403, 'Origen no permitido.')
      }
      const method = req.method as keyof Route['methods']
      const handler = Object.hasOwn(route.methods, method)
        ? route.methods[method]
        : undefined
      if (!handler) throw new HttpError(405, 'Método no permitido.')
      await handler({
        req,
        res,
        url,
        day,
        id,
        send,
        json: (limit) => readJson(req, limit),
      })
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      // Retain the existing 400 response for repository validation failures.
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof NotFoundError
            ? 404
            : 400
      send(status, {
        error:
          error instanceof Error
            ? error.message
            : 'No se pudieron guardar los cambios.',
      })
    }
  }
}
