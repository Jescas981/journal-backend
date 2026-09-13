import { OAuth2Client } from 'google-auth-library'
import { googleAuthLibrary } from 'google-gax'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Optional local development credential source. Cloud Run uses its service account via ADC.
// Tokens remain in memory and never enter logs, files, or the frontend.
export function localGcloudAuth(projectId: string) {
  const executable = process.env.GCLOUD_EXECUTABLE
  if (!executable) return undefined
  if (process.env.K_SERVICE)
    throw new Error('GCLOUD_EXECUTABLE solo se admite localmente.')
  const client = new OAuth2Client()
  const refresh = async () => {
    try {
      const { stdout } = await promisify(execFile)(
        executable,
        ['auth', 'print-access-token', `--project=${projectId}`, '--quiet'],
        { timeout: 30_000, maxBuffer: 64 * 1024 },
      )
      const token = stdout.trim()
      if (!token || /\s/.test(token)) throw new Error('Invalid token')
      return { access_token: token, expiry_date: Date.now() + 10 * 60_000 }
    } catch {
      throw new Error(
        'No se pudo usar la sesión local de gcloud. Comprueba gcloud auth login.',
      )
    }
  }
  client.refreshHandler = refresh
  const firestoreClient = new googleAuthLibrary.OAuth2Client()
  firestoreClient.refreshHandler = refresh
  return {
    firestore: new googleAuthLibrary.GoogleAuth({
      projectId,
      authClient: firestoreClient,
    }),
    storage: client,
  }
}
