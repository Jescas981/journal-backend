import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createStore } from './fixtures/store.mjs'
import { createTaskApi } from '../src/task-api.ts'
import { emptyReflection, emptyTask } from '../src/domain/models.ts'

function client(api) {
  return async (path, method = 'GET', body, headers = {}) => {
    const req = Readable.from(
      body === undefined
        ? []
        : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))],
    )
    Object.assign(req, {
      url: path,
      method,
      headers: { host: 'localhost:5173', ...headers },
    })
    let status, responseHeaders, bytes
    const res = {
      headersSent: false,
      writeHead(code, values) {
        status = code
        responseHeaders = values
        this.headersSent = true
      },
      end(value) {
        bytes = value === undefined ? Buffer.alloc(0) : Buffer.from(value)
      },
      destroy() {
        throw new Error('Unexpected destroyed response')
      },
    }
    await api(req, res, () => {
      res.writeHead(404, {})
      res.end()
    })
    return {
      status,
      headers: responseHeaders,
      bytes,
      body:
        responseHeaders?.['Content-Type'] === 'application/json'
          ? JSON.parse(bytes)
          : undefined,
    }
  }
}
test('HTTP contract: tasks, entry, goals, records, images and reports preserve their responses', async () => {
  const store = createStore(':memory:')
  const request = client(createTaskApi(store))
  const day = '2026-09-13'
  try {
    const created = await request(`/api/tasks?day=${day}`, 'POST', {
      ...emptyTask,
      kind: 'task',
      title: 'Read',
    })
    assert.equal(created.status, 200)
    const id = created.body.id
    assert.ok(id)
    const other = await request('/api/tasks?day=2026-09-12')
    assert.equal(
      other.body.some((task) => task.id === id),
      false,
    )
    const updated = await request(`/api/tasks?day=${day}&id=${id}`, 'PUT', {
      ...emptyTask,
      kind: 'task',
      title: 'Read',
      completed: true,
    })
    assert.equal(updated.body.completed, true)
    assert.equal(
      (
        await request(`/api/entry?day=${day}`, 'PUT', {
          tasks: [{ ...updated.body }],
        })
      ).status,
      200,
    )
    const goal = await request('/api/goals', 'POST', {
      title: 'Learn',
      year: 2026,
    })
    assert.equal(goal.status, 200)
    assert.equal(
      (
        await request('/api/objectives', 'POST', {
          title: 'Read',
          goalId: goal.body.id,
          targetHours: 10,
        })
      ).status,
      200,
    )
    const mood = await request(`/api/moods?day=${day}`, 'POST', {
      score: 8,
      description: 'Happy',
    })
    assert.equal(mood.status, 201)
    assert.equal(
      (await request(`/api/moods?day=${day}&id=${mood.body.id}`, 'DELETE'))
        .status,
      200,
    )
    assert.equal(
      (await request(`/api/moods?day=${day}&id=${mood.body.id}`, 'DELETE'))
        .status,
      404,
    )
    const journal = await request(`/api/journals?day=${day}`, 'POST', {
      title: 'Today',
      body: 'Reflection',
    })
    assert.equal(journal.status, 201)
    assert.ok(journal.body.createdAt)
    assert.equal(
      (
        await request(`/api/reflection?day=${day}`, 'PUT', {
          ...emptyReflection,
          gratitude: 'Family',
        })
      ).status,
      200,
    )
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const image = await request(
      `/api/images?day=${day}&name=test.png`,
      'POST',
      png,
    )
    assert.equal(image.status, 201)
    const download = await request(`/api/images?day=${day}&id=${image.body.id}`)
    assert.deepEqual(download.bytes, png)
    assert.equal(download.headers['Content-Type'], 'image/png')
    assert.equal(
      (
        await request(`/api/images?day=${day}&id=${image.body.id}`, 'PUT', {
          cropZoom: 2,
          cropX: 50,
          cropY: 30,
        })
      ).status,
      200,
    )
    assert.equal((await request('/api/overview')).status, 200)
    assert.equal((await request('/api/report')).status, 200)
    assert.equal(
      (await request(`/api/report/entries?start=${day}&end=${day}`)).body
        .journals.length,
      1,
    )
  } finally {
    store.close()
  }
})
test('HTTP boundary rejects invalid data, oversized payloads, foreign origins and unsupported writes', async () => {
  const store = createStore(':memory:')
  const request = client(createTaskApi(store))
  const path = '/api/tasks?day=2026-09-13'
  try {
    assert.equal((await request('/api/tasks?day=invalid')).status, 400)
    assert.equal((await request(path, 'POST', Buffer.from('{'))).status, 400)
    assert.equal(
      (await request(path, 'POST', { title: 'x'.repeat(21_000) })).status,
      413,
    )
    assert.equal(
      (
        await request(
          path,
          'POST',
          { title: 'Blocked' },
          { origin: 'https://elsewhere.test' },
        )
      ).status,
      403,
    )
    assert.equal(
      (await request(path, 'POST', { title: 'Blocked' }, { origin: 'invalid' }))
        .status,
      403,
    )
    assert.equal(
      (
        await request('/api/report', 'POST', {
          ...emptyTask,
          title: 'Must not create a task',
        })
      ).status,
      405,
    )
    assert.equal((await request('/unknown')).status, 404)
    assert.equal(
      store.tasks().some((task) => task.title === 'Must not create a task'),
      false,
    )
  } finally {
    store.close()
  }
})

test('entry saves through a proxy use the configured public origin, not upstream Host', async () => {
  const store = createStore(':memory:')
  const request = client(createTaskApi(store, 'https://journal.example.com'))
  const path = '/api/entry?day=2026-09-13'
  try {
    const saved = await request(
      path,
      'PUT',
      { tasks: [] },
      {
        host: 'backend.example.run.app',
        origin: 'https://journal.example.com',
        'x-forwarded-host': 'journal.example.com',
      },
    )
    assert.equal(saved.status, 200)
    for (const origin of [
      'https://attacker.example.com',
      'http://journal.example.com',
      'null',
    ]) {
      const rejected = await request(
        path,
        'PUT',
        { tasks: [] },
        {
          host: 'backend.example.run.app',
          origin,
          'x-forwarded-host': 'journal.example.com',
        },
      )
      assert.equal(rejected.status, 403)
    }
  } finally {
    store.close()
  }
})
