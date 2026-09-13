import type {
  CalendarEntry,
  CalendarOutbox,
  CalendarSchedule,
} from '../../domain/calendar.d.ts'
import type { AuthConfig } from './auth.types.d.ts'
import { calendarScope, createCalendar } from './calendar.ts'

import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const random = () => randomBytes(32).toString('base64url')
const sessionAge = 7 * 24 * 60 * 60

export function createAuth(
  config: AuthConfig,
  path: string,
  request = fetch,
  importEntries: (day: string, entries: CalendarEntry[]) => void = () => {},
  outbox?: CalendarOutbox,
  schedule?: CalendarSchedule,
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
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, sub TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_accounts (email TEXT PRIMARY KEY, sub TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calendar_account (id INTEGER PRIMARY KEY CHECK(id=1), sub TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_owner (id INTEGER PRIMARY KEY CHECK(id=1), sub TEXT NOT NULL);
  `)
  if (
    !db
      .prepare('PRAGMA table_info(oauth_states)')
      .all()
      .some((column) => column.name === 'calendar')
  )
    db.exec(
      'ALTER TABLE oauth_states ADD COLUMN calendar INTEGER NOT NULL DEFAULT 0',
    )
  const calendar = createCalendar(
    db,
    config,
    importEntries,
    request,
    outbox,
    schedule,
  )
  const legacyOwner = db.prepare('SELECT sub FROM auth_owner WHERE id=1').get()
  const firstEmail = [...allowedEmails][0]
  if (legacyOwner && firstEmail) {
    db.prepare(
      'INSERT OR IGNORE INTO auth_accounts (email, sub) VALUES (?, ?)',
    ).run(firstEmail, legacyOwner.sub)
    if (db.prepare('SELECT id FROM calendar_connection WHERE id=1').get())
      db.prepare('INSERT OR IGNORE INTO calendar_account VALUES (1, ?)').run(
        legacyOwner.sub,
      )
  }
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
  function user(req: IncomingMessage) {
    const row = db
      .prepare(
        'SELECT sub, email, name FROM auth_sessions WHERE hash=? AND expires>?',
      )
      .get(hash(readCookie(req, 'journal_session')), Date.now()) as
      { sub: string; email: string; name: string } | undefined
    return configured && row && allowedEmails.has(row.email) ? row : null
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
      db.prepare('DELETE FROM oauth_states WHERE expires<=?').run(Date.now())
      db.prepare('DELETE FROM auth_sessions WHERE expires<=?').run(Date.now())
      if (req.headers.host !== new URL(origin).host) {
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
        json(res, 200, { user: user(req), configured })
        return
      }
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(
          hash(readCookie(req, 'journal_session')),
        )
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
        if (connectingCalendar && !user(req)) {
          redirect(res, '/')
          return
        }
        const state = random()
        const verifier = random()
        db.prepare(
          'INSERT INTO oauth_states (hash, verifier, expires, calendar) VALUES (?, ?, ?, ?)',
        ).run(
          hash(state),
          verifier,
          Date.now() + 10 * 60_000,
          Number(connectingCalendar),
        )
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
        const pending = db
          .prepare(
            'SELECT verifier, calendar FROM oauth_states WHERE hash=? AND expires>?',
          )
          .get(hash(state), Date.now()) as
          { verifier: string; calendar: number } | undefined
        if (
          !configured ||
          !pending ||
          !state ||
          state !== readCookie(req, 'journal_oauth')
        ) {
          redirect(res, '/?auth_error=state')
          return
        }
        db.prepare('DELETE FROM oauth_states WHERE hash=?').run(hash(state))
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
        const owner = db
          .prepare('SELECT sub FROM auth_accounts WHERE email=?')
          .get(email)
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
        db.prepare(
          'INSERT OR IGNORE INTO auth_accounts (email, sub) VALUES (?, ?)',
        ).run(email, profile.sub)
        if (pending.calendar) {
          const calendarAccount = db
            .prepare('SELECT sub FROM calendar_account WHERE id=1')
            .get()
          if (calendarAccount && calendarAccount.sub !== profile.sub) {
            redirect(res, '/?auth_error=calendar_account')
            return
          }
          calendar.grant(token)
          db.prepare(
            'INSERT OR IGNORE INTO calendar_account VALUES (1, ?)',
          ).run(profile.sub)
        }
        const session = random()
        db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(
          hash(readCookie(req, 'journal_session')),
        )
        db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?)').run(
          hash(session),
          profile.sub,
          email,
          typeof profile.name === 'string' ? profile.name : email,
          Date.now() + sessionAge * 1000,
        )
        res.setHeader('Set-Cookie', [
          cookie('journal_oauth', '', 0),
          cookie('journal_session', session, sessionAge),
        ])
        redirect(res, pending.calendar ? '/#/entry' : '/')
        return
      }
      if (url.pathname.startsWith('/api/')) {
        if (!user(req)) {
          json(res, 401, { error: 'Inicia sesión con Google para acceder.' })
          return
        }
        if (url.pathname === '/api/calendar') {
          try {
            const day = url.searchParams.get('day') ?? ''
            if (req.method === 'GET') json(res, 200, calendar.status(day))
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
        if (
          [
            '/api/entry',
            '/api/tasks',
            '/api/templates',
            '/api/templates/apply',
          ].includes(url.pathname) &&
          ['PUT', 'POST', 'DELETE'].includes(req.method ?? '')
        ) {
          res.once('finish', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              // The durable outbox retains failed writes for the next sync.
              void calendar.flush().catch(() => {})
            }
          })
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
  return { middleware, close: () => db.close() }
}
