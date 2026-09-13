import type { Services } from '../../application/create-services.types.d.ts'

import type { Routes } from '../contracts.types.d.ts'

export function taskRoutes(service: Services['tasks']): Routes {
  return {
    '/api/tasks': {
      day: true,
      methods: {
        GET: async (c) => {
          c.send(200, await service.list(c.day))
        },
        POST: async (c) => {
          c.send(200, await service.save(c.day, await c.json(), c.id, false))
        },
        PUT: async (c) => {
          c.send(200, await service.save(c.day, await c.json(), c.id, true))
        },
        DELETE: async (c) => {
          await service.remove(c.day, c.id)
          c.send(200, { ok: true })
        },
      },
    },
    '/api/entry': {
      day: true,
      methods: {
        PUT: async (c) => {
          c.send(200, await service.saveEntry(c.day, await c.json(2_000_000)))
        },
      },
    },
  }
}
