import type { IncomingMessage } from 'node:http'
import { HttpError } from './contracts.ts'

export async function readBytes(
  req: IncomingMessage,
  limit: number,
  message = 'El contenido es demasiado largo.',
) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new HttpError(413, message)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
export async function readJson(
  req: IncomingMessage,
  limit = 20_000,
  invalid = 'Datos no válidos.',
  oversized?: string,
): Promise<unknown> {
  const raw = await readBytes(req, limit, oversized)
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new HttpError(400, invalid)
  }
}
