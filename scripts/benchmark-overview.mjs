import { loadEnvFile } from 'node:process'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
loadEnvFile('.env')
const { CloudDatabase } =
  await import('../src/infrastructure/firestore/database.ts')
const { createCloudStore } =
  await import('../src/infrastructure/firestore/store.ts')
const db = new CloudDatabase(),
  store = createCloudStore(db)
try {
  for (let i = 0; i < 2; i++) {
    const start = performance.now()
    const data = await store.overview()
    console.log(
      JSON.stringify({
        run: i + 1,
        ms: Math.round(performance.now() - start),
        tasks: data.tasks.length,
        digest: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      }),
    )
  }
} finally {
  await db.close()
}
