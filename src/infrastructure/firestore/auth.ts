import type { CalendarEntry } from '../../domain/calendar.d.ts'
import type { AuthConfig } from './auth.types.d.ts'
import { calendarScope, createCalendar } from './calendar.ts'

import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CloudDatabase } from './database.ts'
import type { createCloudStore } from './store.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const random = () => randomBytes(32).toString('base64url')
const sessionAge = 7 * 24 * 60 * 60

export function createCloudAuth(
  config: AuthConfig,
  db: CloudDatabase,
  request = fetch,
  importEntries: (
    day: string,
    entries: CalendarEntry[],
  ) => Promise<void> = async () => {},
  outbox?: ReturnType<typeof createCloudStore>['calendarOutbox'],
  schedule?: ReturnType<typeof createCloudStore>['calendarSchedule'],
) {
  const origin = new URL(config.origin).origin
  if (
    new URL(origin).protocol !== 'https:' &&
    !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)
  ) {
    throw new Error('La autenticación requiere HTTPS fuera de localhost.')
  }
  const secure = origin.startsWith('https:') ? '; Secure' : ''
  const allowedEmails = new Set(
    config.allowedEmail
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )
  const configured = Boolean(
    config.clientId && config.clientSecret && allowedEmails.size,
  )
  const calendar = createCalendar(
    db,
    config,
    importEntries,
    request,
    outbox,
    schedule,
  )
  function cookie(name: string, value: string, age: number) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`
  }
  function readCookie(req: IncomingMessage, name: string) {
    return (
      (req.headers.cookie ?? '')
        .split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${name}=`))
        ?.slice(name.length + 1) ?? ''
    )
  }
  async function user(req: IncomingMessage) {
    if (!configured || !readCookie(req, 'journal_session')) return null
    const row = await db.get('auth_sessions', {
      hash: hash(readCookie(req, 'journal_session')),
    })
    return configured &&
      row &&
      row.expires > Date.now() &&
      allowedEmails.has(row.email)
      ? { sub: row.sub, email: row.email, name: row.name }
      : null
  }
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }
  const redirect = (res: ServerResponse, location: string) => {
    res.writeHead(302, {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
    res.end()
  }

  async function middleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) {
    const url = new URL(req.url ?? '/', origin)
    if (!url.pathname.startsWith('/auth/') && !url.pathname.startsWith('/api/'))
      return next()
    try {
      const forwardedHost = req.headers['x-forwarded-host']

      const publicHost =  typeof forwardedHost === 'string' ? forwardedHost.split(',')[0].trim() : req.headers.host

      if (publicHost !== new URL(origin).host) {
        json(res, 400, {
          error: 'Abre la aplicación desde su dirección configurada.',
        })
        return
      }
      if (
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        req.headers.origin !== origin
      ) {
        json(res, 403, { error: 'Origen no permitido.' })
        return
      }
      if (url.pathname === '/auth/session' && req.method === 'GET') {
        json(res, 200, { user: await user(req), configured })
        return
      }
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        await db.remove('auth_sessions', {
          hash: hash(readCookie(req, 'journal_session')),
        })
        res.setHeader('Set-Cookie', cookie('journal_session', '', 0))
        json(res, 200, { ok: true })
        return
      }
      if (
        ['/auth/google', '/auth/calendar'].includes(url.pathname) &&
        req.method === 'GET'
      ) {
        if (!configured) {
          json(res, 503, {
            error: 'Falta configurar el acceso con Google en el servidor.',
          })
          return
        }
        const connectingCalendar = url.pathname === '/auth/calendar'
        if (
          connectingCalendar &&
          process.env.CALENDAR_SYNC_ENABLED === 'false'
        ) {
          json(res, 409, {
            error: 'Calendar está en pausa durante la prueba local.',
          })
          return
        }
        if (connectingCalendar && !(await user(req))) {
          redirect(res, '/')
          return
        }
        const state = random()
        const verifier = random()
        await db.set('oauth_states', {
          hash: hash(state),
          verifier,
          expires: Date.now() + 10 * 60_000,
          calendar: Number(connectingCalendar),
        })
        res.setHeader('Set-Cookie', cookie('journal_oauth', state, 600))
        const authorize = new URL(
          'https://accounts.google.com/o/oauth2/v2/auth',
        )
        authorize.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: `${origin}/auth/callback`,
          response_type: 'code',
          scope: connectingCalendar
            ? `openid email profile ${calendarScope}`
            : 'openid email profile',
          ...(connectingCalendar
            ? { access_type: 'offline', include_granted_scopes: 'true' }
            : {}),
          state,
          code_challenge: createHash('sha256')
            .update(verifier)
            .digest('base64url'),
          code_challenge_method: 'S256',
          prompt: connectingCalendar
            ? 'consent select_account'
            : 'select_account',
        }).toString()
        redirect(res, authorize.toString())
        return
      }
      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        const state = url.searchParams.get('state') ?? ''
        const pending = await db.get('oauth_states', { hash: hash(state) })
        if (
          !configured ||
          !pending ||
          pending.expires <= Date.now() ||
          !state ||
          state !== readCookie(req, 'journal_oauth')
        ) {
          redirect(res, '/?auth_error=state')
          return
        }
        const consumed = await db.consume('oauth_states', { hash: hash(state) })
        if (!consumed || consumed.expires <= Date.now()) {
          redirect(res, '/?auth_error=state')
          return
        }
        res.setHeader('Set-Cookie', cookie('journal_oauth', '', 0))
        const code = url.searchParams.get('code')
        if (!code || url.searchParams.has('error')) {
          redirect(res, '/?auth_error=cancelled')
          return
        }
        const tokenResponse = await request(
          'https://oauth2.googleapis.com/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code,
              client_id: config.clientId,
              client_secret: config.clientSecret,
              redirect_uri: `${origin}/auth/callback`,
              grant_type: 'authorization_code',
              code_verifier: pending.verifier,
            }),
            signal: AbortSignal.timeout(15_000),
          },
        )
        if (!tokenResponse.ok) throw new Error('Google token exchange failed')
        const token = (await tokenResponse.json()) as {
          scope?: unknown
          refresh_token?: unknown
          access_token?: unknown
        }
        if (typeof token.access_token !== 'string')
          throw new Error('Missing access token')
        // Identity is read directly from Google's authenticated userinfo endpoint.
        // No unverified ID-token claims are used. Calendar refresh tokens are encrypted.
        const profileResponse = await request(
          'https://openidconnect.googleapis.com/v1/userinfo',
          {
            headers: { Authorization: `Bearer ${token.access_token}` },
            signal: AbortSignal.timeout(15_000),
          },
        )
        if (!profileResponse.ok) throw new Error('Google profile failed')
        const profile = (await profileResponse.json()) as {
          email?: unknown
          email_verified?: unknown
          sub?: unknown
          name?: unknown
        }
        const email =
          typeof profile.email === 'string' ? profile.email.toLowerCase() : ''
        const owner = await db.get('auth_accounts', { email })
        if (
          profile.email_verified !== true ||
          !allowedEmails.has(email) ||
          typeof profile.sub !== 'string' ||
          !profile.sub ||
          (owner && owner.sub !== profile.sub)
        ) {
          redirect(res, '/?auth_error=denied')
          return
        }
        await db.change('auth_accounts', { email }, (row) => {
          if (row && row.sub !== profile.sub)
            throw new Error('Account binding mismatch')
          return row ?? { email, sub: profile.sub }
        })
        if (pending.calendar) {
          const calendarAccount = await db.get('calendar_account', { id: 1 })
          if (calendarAccount && calendarAccount.sub !== profile.sub) {
            redirect(res, '/?auth_error=calendar_account')
            return
          }
          await db.change('calendar_account', { id: 1 }, (row) => {
            if (row && row.sub !== profile.sub)
              throw new Error('Calendar account mismatch')
            return row ?? { id: 1, sub: profile.sub }
          })
          await calendar.grant(token)
        }
        const session = random()
        await db.remove('auth_sessions', {
          hash: hash(readCookie(req, 'journal_session')),
        })
        await db.set('auth_sessions', {
          hash: hash(session),
          sub: profile.sub,
          email,
          name: typeof profile.name === 'string' ? profile.name : email,
          expires: Date.now() + sessionAge * 1000,
        })
        res.setHeader('Set-Cookie', [
          cookie('journal_oauth', '', 0),
          cookie('journal_session', session, sessionAge),
        ])
        redirect(res, pending.calendar ? '/#/entry' : '/')
        return
      }
      if (url.pathname.startsWith('/api/')) {
        if (!(await user(req))) {
          json(res, 401, { error: 'Inicia sesión con Google para acceder.' })
          return
        }
        if (url.pathname === '/api/calendar') {
          if (process.env.CALENDAR_SYNC_ENABLED === 'false') {
            json(
              res,
              req.method === 'GET' ? 200 : 409,
              req.method === 'GET'
                ? { connected: false, calendarId: null }
                : { error: 'Calendar está en pausa durante la prueba local.' },
            )
            return
          }
          try {
            const day = url.searchParams.get('day') ?? ''
            if (req.method === 'GET') json(res, 200, await calendar.status(day))
            else if (req.method === 'DELETE') {
              await calendar.disconnect()
              json(res, 200, { ok: true })
            } else if (req.method === 'POST') {
              if (url.searchParams.get('action') === 'create')
                json(res, 200, await calendar.initialize())
              else
                json(
                  res,
                  200,
                  await calendar.sync(
                    day,
                    url.searchParams.get('timeZone') || 'America/Lima',
                  ),
                )
            } else json(res, 405, { error: 'Método no permitido.' })
          } catch (error) {
            json(res, 400, {
              error:
                error instanceof Error
                  ? error.message
                  : 'No se pudo actualizar Calendar.',
            })
          }
          return
        }
        res.setHeader('Cache-Control', 'private, no-store')
        return next()
      }
      json(res, 404, { error: 'Ruta no disponible.' })
    } catch {
      // Do not log credentials, authorization codes, tokens or Google responses.
      if (url.pathname === '/auth/callback')
        redirect(res, '/?auth_error=google')
      else json(res, 500, { error: 'No se pudo completar la autenticación.' })
    }
  }
  return { middleware, close: () => {} }
}
