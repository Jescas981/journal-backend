import type { Services } from '../../application/create-services.types.d.ts'

import type { Routes } from '../contracts.types.d.ts'

export function entryRoutes({
  journals,
  moods,
  reflections,
}: Pick<Services, 'journals' | 'moods' | 'reflections'>): Routes {
  return {
    '/api/journals': {
      day: true,
      methods: {
        GET: async (c) => {
          c.send(200, await journals.list(c.day))
        },
        POST: async (c) => {
          c.send(
            201,
            await journals.save(c.day, await c.json(700_000), c.id, false),
          )
        },
        PUT: async (c) => {
          c.send(
            200,
            await journals.save(c.day, await c.json(700_000), c.id, true),
          )
        },
        DELETE: async (c) => {
          await journals.remove(c.day, c.id)
          c.send(200, { ok: true })
        },
      },
    },
    '/api/moods': {
      day: true,
      methods: {
        GET: async (c) => {
          c.send(200, await moods.list(c.day))
        },
        POST: async (c) => {
          c.send(201, await moods.add(c.day, await c.json()))
        },
        DELETE: async (c) => {
          await moods.remove(c.day, c.id)
          c.send(200, { ok: true })
        },
      },
    },
    '/api/reflection': {
      day: true,
      methods: {
        GET: async (c) => {
          c.send(200, await reflections.get(c.day))
        },
        PUT: async (c) => {
          c.send(200, await reflections.save(c.day, await c.json(700_000)))
        },
      },
    },
  }
}
