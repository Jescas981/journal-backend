import type { Services } from '../../application/create-services.types.d.ts'

import { MAX_IMAGE_BYTES } from '../../domain/images.ts'
import type { Routes } from '../contracts.types.d.ts'

import { readBytes, readJson } from '../body.ts'

export function imageRoutes(service: Services['images']): Routes {
  return {
    '/api/images': {
      day: true,
      methods: {
        GET: async (c) => {
          if (!c.id) {
            c.send(200, await service.list(c.day))
            return
          }
          const image = await service.get(c.day, c.id)
          c.res.writeHead(200, {
            'Content-Type': image.mimeType,
            'Content-Length': image.data.length,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
          })
          c.res.end(image.data)
        },
        POST: async (c) => {
          const bytes = await readBytes(
            c.req,
            MAX_IMAGE_BYTES,
            'La imagen debe pesar como máximo 5 MB.',
          )
          c.send(
            201,
            await service.add(
              c.day,
              c.url.searchParams.get('name') ?? '',
              bytes,
            ),
          )
        },
        PUT: async (c) => {
          const crop = await readJson(
            c.req,
            1000,
            'Recorte no válido.',
            'Recorte demasiado grande.',
          )
          c.send(200, await service.crop(c.day, c.id, crop))
        },
        DELETE: async (c) => {
          await service.remove(c.day, c.id)
          c.send(200, { ok: true })
        },
      },
    },
  }
}
