import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { createPersistence } from './bootstrap/persistence.ts'
import { createTaskApi } from './task-api.ts'

// Resolve data and configuration from the project, regardless of the caller's cwd.
process.chdir(fileURLToPath(new URL('../', import.meta.url)))
if (existsSync('.env')) loadEnvFile('.env')
const backend = process.env.DATA_BACKEND || 'sqlite'
if (!['sqlite', 'firestore'].includes(backend))
  throw new Error('DATA_BACKEND no válido.')
if (process.env.K_SERVICE && backend !== 'firestore') {
  throw new Error(
    'Cloud Run requiere DATA_BACKEND=firestore; SQLite local no es persistente.',
  )
}
const port = Number(process.env.PORT || process.env.BACKEND_PORT || 3002)
const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1')
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Puerto no válido.')
const config = {
  clientId: process.env.GOOGLE_CLIENT_ID ?? '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  allowedEmail: process.env.GOOGLE_ALLOWED_EMAIL ?? '',
  tokenKey: process.env.CALENDAR_TOKEN_KEY,
  origin: process.env.APP_ORIGIN || 'http://localhost:5173',
}
const { store, auth } = await createPersistence(backend, config)
const taskApi = createTaskApi(store, config.origin)
const server = createServer((req, res) => {
  if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method ?? '')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    res.end(
      req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }),
    )
    return
  }
  function failed() {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Error interno del servidor.' }))
    } else res.destroy()
  }
  void auth
    .middleware(req, res, () => {
      void taskApi(req, res, () => {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Ruta no encontrada.' }))
      }).catch(failed)
    })
    .catch(failed)
})
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  server.close(async () => {
    auth.close()
    await store.close()
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
server.on('error', async (error) => {
  console.error('No se pudo iniciar el backend:', error.message)
  auth.close()
  await store.close()
  process.exitCode = 1
})
server.listen(port, host, () => {
  console.log(`Journal backend: http://${host}:${port}`)
})
