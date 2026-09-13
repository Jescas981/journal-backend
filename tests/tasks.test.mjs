import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

test('tasks persist and remain isolated by day', async () => {
  const originalDirectory = process.cwd()
  const directory = mkdtempSync(`${tmpdir()}/journal-test-`)
  process.chdir(directory)
  const { taskApi } = await import('../src/tasks.ts')
  const server = createServer((req, res) => {
    void taskApi(req, res, () => {
      res.writeHead(404)
      res.end()
    })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const base = `http://127.0.0.1:${server.address().port}/api/tasks`
    async function request(day, method = 'GET', body, id = '') {
      const response = await fetch(`${base}?day=${day}&id=${id}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      return { status: response.status, body: await response.json() }
    }
    assert.deepEqual((await request('2026-09-05')).body, [])
    const draft = {
      title: 'Test task',
      description: 'Details',
      completed: false,
      milestone: true,
    }
    const created = await request('2026-09-05', 'POST', draft)
    assert.equal(created.status, 200)
    assert.equal(created.body.milestone, true)
    assert.equal((await request('2026-09-06')).body.length, 0)
    assert.equal((await request('2026-09-05')).body[0].title, draft.title)
    assert.equal(
      (await request('2026-09-06', 'PUT', draft, created.body.id)).status,
      400,
    )
    await request(
      '2026-09-05',
      'PUT',
      { ...draft, completed: true },
      created.body.id,
    )
    assert.equal((await request('2026-09-05')).body[0].completed, true)
    const persisted = new DatabaseSync('data/journal.sqlite')
    assert.equal(
      persisted
        .prepare('SELECT completed FROM tasks WHERE id = ?')
        .get(created.body.id).completed,
      1,
    )
    persisted.close()
    assert.equal((await request('2026-02-30')).status, 400)
    assert.equal(
      (await request('2026-09-05', 'POST', { ...draft, title: ' ' })).status,
      400,
    )
    await request('2026-09-05', 'DELETE', undefined, created.body.id)
    assert.equal((await request('2026-09-05')).body.length, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    process.chdir(originalDirectory)
    rmSync(directory, { recursive: true, force: true })
  }
})
