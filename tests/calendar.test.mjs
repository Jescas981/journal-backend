import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  createCalendar,
  calendarScope,
} from '../src/infrastructure/sqlite/calendar.ts'
import { createStore } from './fixtures/store.mjs'

const config = {
  clientId: 'client',
  clientSecret: 'secret',
  tokenKey: 'ab'.repeat(32),
}

test('calendar imports paginate, use local date and real elapsed hours, skip all-day events, and encrypt refresh tokens', async () => {
  const db = new DatabaseSync(':memory:')
  const store = createStore(':memory:')
  let refreshes = 0
  let fail = false
  const calendar = createCalendar(
    db,
    config,
    store.importCalendar,
    async (url, options) => {
      if (url.includes('/token')) {
        refreshes++
        assert.equal(options.body.get('refresh_token'), 'private-refresh')
        return Response.json({ access_token: 'access', expires_in: 3600 })
      }
      if (url.endsWith('/calendars'))
        return Response.json({ id: 'journal-calendar' })
      if (fail) return new Response('', { status: 503 })
      assert.equal(options.headers.Authorization, 'Bearer access')
      if (new URL(url).searchParams.has('pageToken'))
        return Response.json({
          items: [
            {
              id: 'all-day',
              start: { date: '2026-09-05' },
              end: { date: '2026-09-06' },
            },
          ],
        })
      return Response.json({
        nextPageToken: 'next',
        items: [
          {
            id: 'night',
            summary: 'Paper',
            start: { dateTime: '2026-09-06T03:00:00Z' },
            end: { dateTime: '2026-09-06T05:30:00Z' },
          },
          {
            id: 'other-day',
            start: { dateTime: '2026-09-05T03:00:00Z' },
            end: { dateTime: '2026-09-05T04:00:00Z' },
          },
        ],
      })
    },
  )
  try {
    assert.throws(() =>
      calendar.grant({ scope: 'openid', refresh_token: 'private-refresh' }),
    )
    calendar.grant({ scope: calendarScope, refresh_token: 'private-refresh' })
    assert.notEqual(
      db.prepare('SELECT refresh FROM calendar_connection').get().refresh,
      'private-refresh',
    )
    await calendar.initialize()
    await calendar.initialize()
    assert.equal(calendar.status('2026-09-05').calendarId, 'journal-calendar')
    await calendar.sync('2026-09-05', 'America/Lima')
    const task = store.tasks('2026-09-05')[0]
    assert.equal(task.title, 'Paper')
    assert.equal(task.hours, 2.5)
    assert.equal(task.calendarEventId, 'journal-calendar/night')
    await calendar.sync('2026-09-05', 'America/Lima')
    assert.equal(store.tasks('2026-09-05').length, 1)
    assert.equal(refreshes, 1)
    fail = true
    await assert.rejects(calendar.sync('2026-09-05', 'America/Lima'))
    assert.equal(store.tasks('2026-09-05').length, 1)
    await calendar.disconnect()
    assert.equal(calendar.status('2026-09-05').connected, false)
    await assert.rejects(calendar.sync('2026-09-05', 'America/Lima'))
  } finally {
    store.close()
    db.close()
  }
})

test('import updates Google fields, preserves score/completion, respects local deletion and moves days without duplication', () => {
  const store = createStore(':memory:')
  const entry = {
    eventId: 'calendar/event',
    title: 'Study',
    description: 'TOEFL',
    hours: 1,
  }
  try {
    store.importCalendar('2026-09-05', [entry])
    let task = store.tasks('2026-09-05')[0]
    store.saveTask(
      task.day,
      {
        ...task,
        importance: 8,
        depth: 7,
        impact: 9,
        objectiveId: 'example-objective-0',
      },
      task.id,
      true,
    )
    store.importCalendar(task.day, [{ ...entry, hours: 2, title: 'Updated' }])
    task = store.tasks(task.day)[0]
    assert.equal(task.hours, 2)
    assert.equal(task.title, 'Updated')
    assert.equal(task.importance, 8)
    assert.equal(task.objectiveId, 'example-objective-0')
    store.importCalendar('2026-09-06', [entry])
    assert.equal(store.tasks('2026-09-05').length, 0)
    task = store.tasks('2026-09-06')[0]
    assert.equal(task.id, store.overview().tasks[0].id)
    store.saveTask(task.day, { ...task, completed: true }, task.id, true)
    store.importCalendar(task.day, [])
    assert.equal(store.tasks(task.day)[0].completed, true)
    store.importCalendar('2026-09-07', [{ ...entry, eventId: 'other' }])
    const removed = store.tasks('2026-09-07')[0]
    store.deleteTask(removed.day, removed.id)
    store.importCalendar(removed.day, [{ ...entry, eventId: 'other' }])
    assert.equal(store.tasks(removed.day).length, 0)
    store.importCalendar('2026-09-08', [{ ...entry, eventId: 'cancelled' }])
    store.importCalendar('2026-09-08', [])
    assert.equal(store.tasks('2026-09-08').length, 0)
    store.importCalendar('2026-09-08', [{ ...entry, eventId: 'cancelled' }])
    assert.equal(store.tasks('2026-09-08').length, 1)
  } finally {
    store.close()
  }
})

test('completion synchronizes both ways, retries safely and only patches the title', async () => {
  const db = new DatabaseSync(':memory:')
  const store = createStore(':memory:')
  let summary = 'Paper'
  let fail = false
  let patches = 0
  const event = () => ({
    id: 'event',
    summary,
    etag: 'version',
    start: { dateTime: '2026-09-05T10:00:00-05:00' },
    end: { dateTime: '2026-09-05T11:00:00-05:00' },
  })
  const calendar = createCalendar(
    db,
    config,
    store.importCalendar,
    async (url, options) => {
      if (url.includes('/token'))
        return Response.json({ access_token: 'access' })
      if (url.endsWith('/calendars')) return Response.json({ id: 'calendar' })
      if (options.method === 'PATCH') {
        if (fail) return new Response('', { status: 412 })
        assert.equal(options.headers['If-Match'], 'version')
        assert.equal(new URL(url).searchParams.get('sendUpdates'), 'none')
        const body = JSON.parse(options.body)
        assert.deepEqual(Object.keys(body), ['summary'])
        summary = body.summary
        patches++
        return Response.json(event())
      }
      if (new URL(url).pathname.endsWith('/events/event'))
        return Response.json(event())
      return Response.json({ items: [event()] })
    },
    store.calendarOutbox,
  )
  const day = '2026-09-05'
  try {
    calendar.grant({ scope: calendarScope, refresh_token: 'refresh' })
    await calendar.initialize()
    await calendar.sync(day, 'America/Lima')
    let task = store.tasks(day)[0]
    store.saveDay(day, [{ ...task, completed: true, importance: 9 }])
    fail = true
    await assert.rejects(calendar.sync(day, 'America/Lima'))
    assert.equal(store.calendarOutbox.pending(day).length, 1)
    store.importCalendar(day, [
      {
        eventId: 'calendar/event',
        title: 'Paper',
        description: '',
        hours: 1,
        completed: false,
      },
    ])
    assert.equal(store.tasks(day)[0].completed, true)
    fail = false
    summary = 'Paper revisado'
    await calendar.sync(day, 'America/Lima')
    assert.equal(summary, '✓ Paper revisado')
    assert.equal(store.calendarOutbox.pending(day).length, 0)
    assert.equal(store.tasks(day)[0].title, 'Paper revisado')
    assert.equal(store.tasks(day)[0].importance, 9)
    await calendar.sync(day, 'America/Lima')
    assert.equal(patches, 1)
    summary = 'Paper revisado'
    await calendar.sync(day, 'America/Lima')
    assert.equal(store.tasks(day)[0].completed, false)
    summary = '✅ Paper revisado'
    await calendar.sync(day, 'America/Lima')
    assert.equal(store.tasks(day)[0].completed, true)
    task = store.tasks(day)[0]
    store.saveDay(day, [{ ...task, completed: false }])
    await calendar.sync(day, 'America/Lima')
    assert.equal(summary, 'Paper revisado')
    assert.equal(store.tasks(day)[0].completed, false)
  } finally {
    store.close()
    db.close()
  }
})

test('acknowledging an older completion cannot discard a newer local toggle', () => {
  const store = createStore(':memory:')
  const day = '2026-09-05'
  try {
    store.importCalendar(day, [
      {
        eventId: 'calendar/event',
        title: 'Paper',
        description: '',
        hours: 1,
        completed: false,
      },
    ])
    const task = store.tasks(day)[0]
    store.saveDay(day, [{ ...task, completed: true }])
    const first = store.calendarOutbox.pending(day)[0]
    store.saveDay(day, [{ ...task, completed: false }])
    store.calendarOutbox.acknowledge(first)
    assert.equal(store.calendarOutbox.pending(day)[0].completed, 0)
    assert.equal(store.calendarOutbox.pending(day)[0].revision, 2)
  } finally {
    store.close()
  }
})

test('completion outbox survives restart and legacy completed tasks are queued only once', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const directory = mkdtempSync(`${tmpdir()}/journal-check-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  const day = '2026-09-05'
  try {
    store.importCalendar(day, [
      {
        eventId: 'calendar/event',
        title: 'Paper',
        description: '',
        hours: 1,
        completed: false,
      },
    ])
    const task = store.tasks(day)[0]
    store.saveDay(day, [{ ...task, completed: true }])
    store.close()
    store = createStore(path)
    assert.equal(store.calendarOutbox.pending()[0].completed, 1)
    store.close()
    const db = new DatabaseSync(path)
    db.exec(
      "DELETE FROM calendar_outbox; DELETE FROM migrations WHERE name='calendar-completion-sync'",
    )
    db.close()
    store = createStore(path)
    const change = store.calendarOutbox.pending()[0]
    assert.equal(change.completed, 1)
    store.calendarOutbox.acknowledge(change)
    store.close()
    store = createStore(path)
    assert.equal(store.calendarOutbox.pending().length, 0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('scheduled templates publish today and two days ahead once, update ranges and delete future events when archived', async () => {
  const { emptyTask } = await import('../src/domain/models.ts')
  const { scheduledRange } = await import('../src/domain/schedule.ts')
  const db = new DatabaseSync(':memory:')
  const store = createStore(':memory:')
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Lima',
  })
  const remote = new Map()
  let inserts = 0
  const calendar = createCalendar(
    db,
    config,
    store.importCalendar,
    async (url, options) => {
      if (url.includes('/token'))
        return Response.json({ access_token: 'access' })
      const path = new URL(url).pathname
      if (path.endsWith('/calendars')) return Response.json({ id: 'calendar' })
      const id = path.split('/').at(-1)
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        if (remote.has(body.id)) return new Response('', { status: 409 })
        inserts++
        remote.set(body.id, { ...body, etag: 'v1' })
        return Response.json(remote.get(body.id))
      }
      if (options.method === 'PATCH') {
        remote.set(id, { ...remote.get(id), ...JSON.parse(options.body) })
        return Response.json(remote.get(id))
      }
      if (options.method === 'DELETE') {
        remote.delete(id)
        return new Response(null, { status: 204 })
      }
      if (path.endsWith('/events'))
        return Response.json({ items: [...remote.values()] })
      return remote.has(id)
        ? Response.json(remote.get(id))
        : new Response('', { status: 404 })
    },
    store.calendarOutbox,
    store.calendarSchedule,
  )
  try {
    const draft = {
      ...emptyTask,
      title: 'Leer',
      startTime: '09:15',
      endTime: '10:00',
      timeZone: 'America/Lima',
      hours: 99,
    }
    const template = store.templates.save(draft, today)
    assert.equal(template.hours, 0.75)
    calendar.grant({ scope: calendarScope, refresh_token: 'refresh' })
    await calendar.initialize()
    await calendar.sync(today, 'America/Lima')
    assert.equal(remote.size, 3)
    assert.equal(inserts, 3)
    assert.equal(store.tasks(today).length, 1)
    assert.equal(store.tasks(today)[0].startTime, '09:15')
    assert.equal(
      [...remote.values()][0].start.dateTime,
      scheduledRange(today, draft).start,
    )
    await calendar.sync(today, 'America/Lima')
    assert.equal(inserts, 3)
    store.templates.save(
      { ...draft, endTime: '10:15' },
      today,
      template.id,
      true,
    )
    await calendar.flush()
    assert.equal(inserts, 3)
    assert.equal(
      [...remote.values()][0].end.dateTime,
      scheduledRange(today, { ...draft, endTime: '10:15' }).end,
    )
    store.templates.save(
      { ...draft, weekdays: [new Date(`${today}T12:00:00Z`).getUTCDay()] },
      today,
      template.id,
      true,
    )
    await calendar.flush()
    assert.equal(remote.size, 1)
    store.templates.save(
      {
        ...draft,
        kind: 'task',
        weekdays: [new Date(`${today}T12:00:00Z`).getUTCDay()],
      },
      today,
      template.id,
      true,
    )
    await calendar.flush()
    assert.equal(remote.size, 0)
    assert.equal(store.tasks(today)[0].kind, 'task')
    assert.equal(store.tasks(today)[0].calendarEventId, null)
    store.templates.save(
      {
        ...draft,
        kind: 'event',
        weekdays: [new Date(`${today}T12:00:00Z`).getUTCDay()],
      },
      today,
      template.id,
      true,
    )
    await calendar.flush()
    assert.equal(remote.size, 1)
    store.templates.archive(template.id, today)
    await calendar.flush()
    assert.equal(remote.size, 0)
  } finally {
    store.close()
    db.close()
  }
})

test('ranges calculate quarter-hours, overnight duration and daylight saving transitions', async () => {
  const { scheduledRange } = await import('../src/domain/schedule.ts')
  assert.equal(
    scheduledRange('2026-09-05', {
      startTime: '09:15',
      endTime: '10:00',
      timeZone: 'America/Lima',
    }).hours,
    0.75,
  )
  assert.equal(
    scheduledRange('2026-09-05', {
      startTime: '23:45',
      endTime: '00:15',
      timeZone: 'America/Lima',
    }).hours,
    0.5,
  )
  assert.equal(
    scheduledRange('2026-03-08', {
      startTime: '01:30',
      endTime: '03:30',
      timeZone: 'America/New_York',
    }).hours,
    1,
  )
  assert.throws(() =>
    scheduledRange('2026-03-08', {
      startTime: '02:30',
      endTime: '03:30',
      timeZone: 'America/New_York',
    }),
  )
  assert.throws(() =>
    scheduledRange('2026-09-05', {
      startTime: '09:15',
      endTime: '09:15',
      timeZone: 'America/Lima',
    }),
  )
})
