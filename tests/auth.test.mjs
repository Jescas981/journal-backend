import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAuth } from '../src/infrastructure/sqlite/auth.ts'

const config = {
  clientId: 'client',
  clientSecret: 'secret',
  allowedEmail: 'owner@example.com',
  origin: 'http://localhost:5173',
}
function call(auth, url, method = 'GET', cookie = '', origin = config.origin) {
  const req = {
    url,
    method,
    headers: { host: 'localhost:5173', cookie, origin },
  }
  const res = {
    headers: {},
    status: 200,
    body: '',
    setHeader(key, value) {
      this.headers[key] = value
    },
    writeHead(status, headers) {
      this.status = status
      Object.assign(this.headers, headers)
    },
    end(body = '') {
      this.body = body
    },
  }
  return auth
    .middleware(req, res, () => {
      res.next = true
    })
    .then(() => res)
}
async function login(auth) {
  const start = await call(auth, '/auth/google')
  const url = new URL(start.headers.Location)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(
    url.searchParams.get('redirect_uri'),
    `${config.origin}/auth/callback`,
  )
  return {
    state: url.searchParams.get('state'),
    cookie: start.headers['Set-Cookie'].split(';')[0],
  }
}
const google =
  (email = config.allowedEmail, verified = true) =>
  async (url) =>
    new Response(
      JSON.stringify(
        url.includes('/token')
          ? { access_token: 'access' }
          : { sub: 'owner-id', email, email_verified: verified, name: 'Owner' },
      ),
      { status: 200 },
    )

test('OAuth binds state to browser and rejects missing state without contacting Google', async () => {
  const auth = createAuth(config, ':memory:', () => {
    throw new Error('Must not call Google')
  })
  try {
    assert.equal((await call(auth, '/api/overview')).status, 401)
    assert.equal(
      (await call(auth, '/api/images?day=2026-09-05&id=private')).status,
      401,
    )
    const attempt = await login(auth)
    const bad = await call(
      auth,
      `/auth/callback?state=${attempt.state}&code=test`,
    )
    assert.equal(bad.headers.Location, '/?auth_error=state')
    assert.equal(
      (await call(auth, '/api/entry', 'PUT', '', 'https://evil.example'))
        .status,
      403,
    )
  } finally {
    auth.close()
  }
})

test('verified owner can log in, access API and revoke session; code cannot replay', async () => {
  const auth = createAuth(config, ':memory:', google())
  try {
    const attempt = await login(auth)
    const callback = `/auth/callback?state=${attempt.state}&code=test`
    const result = await call(auth, callback, 'GET', attempt.cookie)
    assert.equal(result.headers.Location, '/')
    const sessionCookie = result.headers['Set-Cookie'].find((item) =>
      item.startsWith('journal_session='),
    )
    assert.match(sessionCookie, /HttpOnly; SameSite=Lax/)
    const cookie = sessionCookie.split(';')[0]
    assert.equal((await call(auth, '/api/overview', 'GET', cookie)).next, true)
    assert.equal(
      JSON.parse((await call(auth, '/auth/session', 'GET', cookie)).body).user
        .email,
      config.allowedEmail,
    )
    assert.equal(
      (await call(auth, callback, 'GET', attempt.cookie)).headers.Location,
      '/?auth_error=state',
    )
    assert.equal((await call(auth, '/auth/logout', 'POST', cookie)).status, 200)
    assert.equal((await call(auth, '/api/overview', 'GET', cookie)).status, 401)
  } finally {
    auth.close()
  }
})

test('other accounts and unverified email cannot access existing journal', async () => {
  for (const [email, verified] of [
    ['other@example.com', true],
    [config.allowedEmail, false],
  ]) {
    const auth = createAuth(config, ':memory:', google(email, verified))
    try {
      const attempt = await login(auth)
      const response = await call(
        auth,
        `/auth/callback?state=${attempt.state}&code=test`,
        'GET',
        attempt.cookie,
      )
      assert.equal(response.headers.Location, '/?auth_error=denied')
      assert.equal((await call(auth, '/api/overview')).status, 401)
    } finally {
      auth.close()
    }
  }
})

test('missing configuration fails closed and insecure remote origin is rejected', async () => {
  const auth = createAuth({ ...config, clientSecret: '' }, ':memory:', google())
  try {
    assert.equal((await call(auth, '/auth/google')).status, 503)
    assert.equal((await call(auth, '/api/overview')).status, 401)
  } finally {
    auth.close()
  }
  assert.throws(
    () => createAuth({ ...config, origin: 'http://example.com' }, ':memory:'),
    /HTTPS/,
  )
})

test('sessions survive restart and expired sessions are rejected', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { DatabaseSync } = await import('node:sqlite')
  const directory = mkdtempSync(`${tmpdir()}/journal-auth-`)
  const path = `${directory}/auth.sqlite`
  let auth = createAuth(config, path, google())
  try {
    const attempt = await login(auth)
    const response = await call(
      auth,
      `/auth/callback?state=${attempt.state}&code=test`,
      'GET',
      attempt.cookie,
    )
    const cookie = response.headers['Set-Cookie']
      .find((item) => item.startsWith('journal_session='))
      .split(';')[0]
    auth.close()
    auth = createAuth(config, path, google())
    assert.equal((await call(auth, '/api/overview', 'GET', cookie)).next, true)
    const db = new DatabaseSync(path)
    db.exec('UPDATE auth_sessions SET expires=0')
    db.close()
    assert.equal((await call(auth, '/api/overview', 'GET', cookie)).status, 401)
  } finally {
    auth.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Calendar needs a signed-in owner and separate consent before calendar creation', async () => {
  const { calendarScope } =
    await import('../src/infrastructure/sqlite/calendar.ts')
  let calendarCreates = 0
  const auth = createAuth(
    { ...config, tokenKey: 'cd'.repeat(32) },
    ':memory:',
    async (url) => {
      if (url.includes('/token'))
        return Response.json({
          access_token: 'access',
          refresh_token: 'refresh',
          scope: `openid email profile ${calendarScope}`,
        })
      if (url.endsWith('/calendars')) {
        calendarCreates++
        return Response.json({ id: 'journal-calendar' })
      }
      return Response.json({
        sub: 'owner-id',
        email: config.allowedEmail,
        email_verified: true,
      })
    },
  )
  try {
    assert.equal((await call(auth, '/auth/calendar')).headers.Location, '/')
    const initial = await login(auth)
    const signedIn = await call(
      auth,
      `/auth/callback?state=${initial.state}&code=login`,
      'GET',
      initial.cookie,
    )
    const session = signedIn.headers['Set-Cookie']
      .find((item) => item.startsWith('journal_session='))
      .split(';')[0]
    const start = await call(auth, '/auth/calendar', 'GET', session)
    const authorization = new URL(start.headers.Location)
    assert.equal(authorization.searchParams.get('access_type'), 'offline')
    assert.ok(authorization.searchParams.get('scope').includes(calendarScope))
    const response = await call(
      auth,
      `/auth/callback?state=${authorization.searchParams.get('state')}&code=calendar`,
      'GET',
      `${session}; ${start.headers['Set-Cookie'].split(';')[0]}`,
    )
    const newSession = response.headers['Set-Cookie']
      .find((item) => item.startsWith('journal_session='))
      .split(';')[0]
    const status = JSON.parse(
      (await call(auth, '/api/calendar?day=2026-09-05', 'GET', newSession))
        .body,
    )
    assert.equal(status.connected, true)
    assert.equal(status.calendarId, null)
    assert.equal(calendarCreates, 0)
    const created = await call(
      auth,
      '/api/calendar?action=create',
      'POST',
      newSession,
    )
    assert.equal(created.status, 200)
    assert.equal(JSON.parse(created.body).calendarId, 'journal-calendar')
    assert.equal(calendarCreates, 1)
  } finally {
    auth.close()
  }
})

test('both allowed accounts can access the journal and each email stays bound to its Google identity', async () => {
  let email = config.allowedEmail
  let sub = 'first-account'
  const auth = createAuth(
    { ...config, allowedEmail: `${config.allowedEmail}, SECOND@example.com ` },
    ':memory:',
    async (url) =>
      Response.json(
        url.includes('/token')
          ? { access_token: 'access' }
          : { sub, email, email_verified: true },
      ),
  )
  try {
    for (const account of [
      [config.allowedEmail, 'first-account'],
      ['second@example.com', 'second-account'],
    ]) {
      ;[email, sub] = account
      const attempt = await login(auth)
      const response = await call(
        auth,
        `/auth/callback?state=${attempt.state}&code=test`,
        'GET',
        attempt.cookie,
      )
      assert.equal(response.headers.Location, '/')
      const cookie = response.headers['Set-Cookie']
        .find((value) => value.startsWith('journal_session='))
        .split(';')[0]
      assert.equal(
        (await call(auth, '/api/overview', 'GET', cookie)).next,
        true,
      )
    }
    sub = 'different-account'
    const attempt = await login(auth)
    const denied = await call(
      auth,
      `/auth/callback?state=${attempt.state}&code=test`,
      'GET',
      attempt.cookie,
    )
    assert.equal(denied.headers.Location, '/?auth_error=denied')
  } finally {
    auth.close()
  }
})
