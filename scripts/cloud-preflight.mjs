import { CloudDatabase } from '../src/infrastructure/firestore/database.ts'
const db = new CloudDatabase()
try {
  const marker = await db.firestore.doc(`journals/${db.namespace}`).get()
  console.log(
    'Firestore: conexión de lectura OK. Namespace existente:',
    marker.exists,
  )
  const [metadata] = await db.storage.bucket(db.bucketName).getMetadata()
  console.log('Storage: acceso al bucket OK. Ubicación:', metadata.location)
} catch (error) {
  console.error('Preflight falló:', error.code || 'unknown', error.message)
  process.exitCode = 1
} finally {
  await db.close()
}
