import type { Services } from '../../application/create-services.types.d.ts'

import type { Routes } from '../contracts.types.d.ts'

export function goalRoutes(service: Services['goals']): Routes {
  return {
    '/api/goals': {
      methods: {
        POST: async (c) => {
          c.send(200, await service.saveGoal(await c.json(), c.id, false))
        },
        PUT: async (c) => {
          c.send(200, await service.saveGoal(await c.json(), c.id, true))
        },
      },
    },
    '/api/objectives': {
      methods: {
        POST: async (c) => {
          c.send(200, await service.saveObjective(await c.json(), c.id, false))
        },
        PUT: async (c) => {
          c.send(200, await service.saveObjective(await c.json(), c.id, true))
        },
      },
    },
  }
}
