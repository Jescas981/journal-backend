import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Domain, taskTables } from '../src/domain/task-workflow.ts'
import { createStore } from './fixtures/store.mjs'
import { createCloudStore } from '../src/infrastructure/firestore/store.ts'
import { createCloudAuth } from '../src/infrastructure/firestore/auth.ts'
import { keys, documentId } from '../src/infrastructure/firestore/database.ts'
import {
  emptyTask,
  emptyReflection,
  qualityHours,
} from '../src/domain/models.ts'
import { EventEmitter } from 'node:events'

class MemoryCloud {
  tables = Object.fromEntries(Object.keys(keys).map((k) => [k, []]))
  async all(table) {
    return structuredClone(this.tables[table])
  }
  async get(table, key) {
    return (await this.all(table)).find(
      (r) => documentId(table, r) === documentId(table, key),
    )
  }
  async set(table, row) {
    await this.remove(table, row)
    this.tables[table].push(structuredClone(row))
  }
  async remove(table, key) {
    this.tables[table] = this.tables[table].filter(
      (r) => documentId(table, r) !== documentId(table, key),
    )
  }
  async change(table, key, action) {
    const row = action(await this.get(table, key))
    if (row) await this.set(table, row)
    else await this.remove(table, key)
    return row
  }
  async consume(table, key) {
    const row = await this.get(table, key)
    await this.remove(table, key)
    return row
  }
  async exclusive(_name, action) {
    return action()
  }
  async read(_names, action) {
    return action(structuredClone(this.tables))
  }
  async run(names, action) {
    const copy = structuredClone(this.tables)
    const result = action(copy)
    for (const name of names) this.tables[name] = copy[name]
    return result
  }
}
const draft = {
  ...emptyTask,
  title: 'Estudio',
  hours: 1,
  importance: 8,
  depth: 7,
  impact: 6,
}
const comparable = (task) =>
  Object.fromEntries(
    Object.keys(emptyTask)
      .concat(['id', 'day', 'templateId', 'calendarEventId'])
      .map((k) => [k, task[k] ?? null]),
  )

test('Firestore task domain matches SQLite edits, templates, past application and suppression', async () => {
  const sql = createStore(':memory:')
  const db = new MemoryCloud()
  const store = createCloudStore(db)
  const day = '2026-09-07'
  try {
    for (const s of [sql, store]) {
      await s.templates.save(
        {
          ...draft,
          startTime: '09:00',
          endTime: '10:15',
          timeZone: 'America/Lima',
          weekdays: [1, 3],
        },
        day,
        'template',
      )
    }
    let [a] = sql.tasks(day),
      [b] = await store.tasks(day)
    assert.deepEqual(comparable({ ...a, id: b.id }), comparable(b))
    await store.saveTask(day, { ...b, completed: true }, b.id, true)
    sql.saveTask(day, { ...a, completed: true }, a.id, true)
    for (const s of [sql, store])
      await s.templates.save(
        { ...draft, title: 'Nuevo', weekdays: [2] },
        day,
        'template',
        true,
      )
    a = sql.tasks(day)[0]
    b = (await store.tasks(day))[0]
    assert.deepEqual(comparable({ ...a, id: b.id }), comparable(b))
    assert.equal(qualityHours(b), qualityHours(a))
    await store.templates.applyToDay('template', '2026-09-01', day)
    const past = (await store.tasks('2026-09-01'))[0]
    assert.equal(past.title, 'Nuevo')
    await store.deleteTask('2026-09-01', past.id)
    assert.equal((await store.tasks('2026-09-01')).length, 0)
    const checklist = await store.saveTask(day, {
      ...draft,
      kind: 'task',
      hours: 4,
      startTime: '09:00',
      endTime: '10:00',
    })
    assert.equal(checklist.hours, 0)
    assert.equal(checklist.startTime, null)
  } finally {
    sql.close()
  }
})

test('cloud transactions preserve the day on invalid bulk replacement and reject cross-day IDs', async () => {
  const db = new MemoryCloud(),
    store = createCloudStore(db)
  const task = await store.saveTask('2026-09-07', draft, 'one')
  await assert.rejects(store.saveDay('2026-09-08', [task]))
  await assert.rejects(
    store.saveDay('2026-09-07', [{ ...task, objectiveId: 'missing' }]),
  )
  assert.equal((await store.tasks('2026-09-07'))[0].title, 'Estudio')
  await store.saveDay('2026-09-07', [])
  assert.equal((await store.tasks('2026-09-07')).length, 0)
})

test('Firestore records retain notes, journal timestamps, reflection zero and report detail', async () => {
  const db = new MemoryCloud(),
    store = createCloudStore(db),
    day = '2026-09-07'
  const mood = await store.moods.add(day, 8, '  Descansé bien  ')
  assert.equal(mood.description, 'Descansé bien')
  const journal = await store.journals.save(day, 'Reflexión', 'Texto\ncompleto')
  const edited = await store.journals.save(
    day,
    'Reflexión',
    'Otro texto',
    journal.id,
  )
  assert.equal(edited.createdAt, journal.createdAt)
  await store.reflections.save(day, {
    ...emptyReflection,
    actions: 'Descansar',
    rating: 0,
  })
  assert.equal((await store.reflections.get(day)).rating, 0)
  const report = await store.reportEntries(day, day)
  assert.equal(report.moods[0].description, 'Descansé bien')
  assert.equal(report.journals[0].body, 'Otro texto')
  assert.equal((await store.reportExtras()).reflectionDays[0], day)
  assert.equal(await store.moods.remove('2026-09-08', mood.id), false)
  assert.equal(await store.moods.remove(day, mood.id), true)
  assert.throws(() => store.moods.add(day, 11))
  assert.throws(() => store.moods.add(day, 8, 'x'.repeat(2001)))
})

test('Calendar imports preserve pending completion and revision acknowledgments', async () => {
  const db = new MemoryCloud(),
    store = createCloudStore(db),
    day = '2026-09-07'
  const event = {
    eventId: 'calendar/event',
    title: 'Evento',
    description: '',
    hours: 1,
    startTime: '09:00',
    endTime: '10:00',
    timeZone: 'America/Lima',
    completed: false,
  }
  await store.importCalendar(day, [event])
  const task = (await store.tasks(day))[0]
  await store.saveTask(day, { ...task, completed: true }, task.id, true)
  const first = (await store.calendarOutbox.pending())[0]
  assert.equal(first.completed, 1)
  await store.importCalendar(day, [event])
  assert.equal((await store.tasks(day))[0].completed, true)
  await store.saveTask(day, { ...task, completed: false }, task.id, true)
  await store.calendarOutbox.acknowledge(first)
  assert.equal((await store.calendarOutbox.pending())[0].completed, 0)
})

async function call(auth, path, headers = {}, method = 'GET') {
  const req = {
    url: path,
    method,
    headers: { host: 'localhost:5173', ...headers },
  }
  const res = new EventEmitter()
  res.headers = {}
  res.setHeader = (k, v) => (res.headers[k] = v)
  res.writeHead = (status, headers) => {
    res.status = status
    Object.assign(res.headers, headers)
  }
  res.end = (body) => {
    res.body = body
  }
  await auth.middleware(req, res, () => {
    res.status = 204
  })
  return res
}
test('cloud authentication protects routes and consumes OAuth state once', async () => {
  const db = new MemoryCloud()
  const auth = createCloudAuth(
    {
      clientId: 'id',
      clientSecret: 'secret',
      allowedEmail: 'a@example.com',
      origin: 'http://localhost:5173',
    },
    db,
    async () => {
      throw new Error('No network')
    },
  )
  assert.equal((await call(auth, '/api/overview')).status, 401)
  assert.equal(
    (await call(auth, '/auth/session', { host: 'evil.test' })).status,
    400,
  )
  assert.equal(
    (await call(auth, '/api/tasks', { origin: 'https://evil.test' }, 'POST'))
      .status,
    403,
  )
  const login = await call(auth, '/auth/google')
  const state = new URL(login.headers.Location).searchParams.get('state')
  const callback = `/auth/callback?state=${state}&error=access_denied`
  assert.equal(
    (await call(auth, callback, { cookie: `journal_oauth=${state}` })).headers
      .Location,
    '/?auth_error=cancelled',
  )
  assert.equal(
    (await call(auth, callback, { cookie: `journal_oauth=${state}` })).headers
      .Location,
    '/?auth_error=state',
  )
})

test('composite document keys are collision safe and tolerate Google event slashes', () => {
  assert.notEqual(
    documentId('template_versions', { templateId: 'a/b', effectiveDay: 'c' }),
    documentId('template_versions', { templateId: 'a', effectiveDay: 'b/c' }),
  )
  assert.match(
    documentId('calendar_imports', { eventId: 'calendar/event' }),
    /^[a-f0-9]{64}$/,
  )
  const state = Object.fromEntries(taskTables.map((k) => [k, []]))
  const d = new Domain(state)
  assert.equal(d.tasks().length, 0)
  assert.ok(randomUUID())
})

test('overview only reads its five required collections without a write transaction', async () => {
  const db = new MemoryCloud()
  const store = createCloudStore(db)
  const task = await store.saveTask('2026-09-07', draft, 'overview-task')
  const original = db.read.bind(db)
  let requested = []
  db.read = async (names, action) => {
    requested = names
    return original(names, action)
  }
  db.run = () => {
    throw new Error('Overview must not start a write transaction')
  }
  const data = await store.overview()
  assert.deepEqual(requested, [
    'goals',
    'objectives',
    'tasks',
    'template_occurrences',
    'calendar_imports',
  ])
  assert.equal(data.tasks[0].id, task.id)
  assert.equal(data.tasks[0].title, draft.title)
})

test('Calendar key mismatch cannot silently retain an unreadable grant; reconnection preserves the calendar', async () => {
  const { createCalendar, calendarScope } =
    await import('../src/infrastructure/firestore/calendar.ts')
  const db = new MemoryCloud()
  const config = {
    clientId: 'example',
    clientSecret: 'example',
    tokenKey: '11'.repeat(32),
  }
  const original = createCalendar(db, config, async () => {})
  await original.grant({
    scope: calendarScope,
    refresh_token: 'example-refresh',
  })
  await db.change('calendar_connection', { id: 1 }, (row) => ({
    ...row,
    calendarId: 'example-calendar',
  }))
  const before = await db.get('calendar_connection', { id: 1 })
  const replacement = createCalendar(
    db,
    { ...config, tokenKey: '22'.repeat(32) },
    async () => {},
  )
  await assert.rejects(
    replacement.grant({ scope: calendarScope }),
    /No se puede descifrar/,
  )
  assert.deepEqual(await db.get('calendar_connection', { id: 1 }), before)
  await replacement.grant({
    scope: calendarScope,
    refresh_token: 'new-example-refresh',
  })
  await replacement.grant({ scope: calendarScope })
  assert.equal(
    (await db.get('calendar_connection', { id: 1 })).calendarId,
    'example-calendar',
  )
})
