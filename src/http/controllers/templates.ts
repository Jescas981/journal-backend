import type { Services } from '../../application/create-services.types.d.ts'

import type { Routes } from '../contracts.types.d.ts'

export function templateRoutes(service: Services['templates']): Routes {
  return {
    '/api/templates': {
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
          await service.archive(c.day, c.id)
          c.send(200, { ok: true })
        },
      },
    },
    '/api/templates/apply': {
      day: true,
      methods: {
        POST: async (c) => {
          c.send(200, await service.apply(c.day, c.id, await c.json()))
        },
      },
    },
  }
}
