import type { Services } from '../../application/create-services.types.d.ts'

import type { Routes } from '../contracts.types.d.ts'

export function reportRoutes(service: Services['reports']): Routes {
  return {
    '/api/overview': {
      methods: {
        GET: async (c) => {
          c.send(200, await service.overview())
        },
      },
    },
    '/api/report': {
      methods: {
        GET: async (c) => {
          c.send(200, await service.report())
        },
      },
    },
    '/api/report/entries': {
      methods: {
        GET: async (c) => {
          c.send(
            200,
            await service.entries(
              c.url.searchParams.get('start') ?? '',
              c.url.searchParams.get('end') ?? '',
            ),
          )
        },
      },
    },
  }
}
