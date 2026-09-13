import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTaskService } from '../src/application/services/tasks.ts'
import { createMoodService } from '../src/application/services/entries.ts'
import { createTemplateService } from '../src/application/services/templates.ts'
import { emptyTask } from '../src/domain/models.ts'

test('invalid tasks and duplicate entry IDs never reach the injected repository', () => {
  const calls = []
  const service = createTaskService({
    saveTask: (...args) => calls.push(args),
    saveDay: (...args) => calls.push(args),
  })
  assert.throws(() =>
    service.save(
      '2026-09-13',
      { ...emptyTask, title: 'Study', impact: 11 },
      '',
      false,
    ),
  )
  const task = { ...emptyTask, title: 'Study', id: 'one' }
  assert.throws(() => service.saveEntry('2026-09-13', { tasks: [task, task] }))
  assert.throws(() => service.save('invalid', task, '', false))
  assert.deepEqual(calls, [])
  service.save('2026-09-13', { ...emptyTask, title: 'Study' }, '', false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '2026-09-13')
  assert.match(calls[0][2], /^[a-f0-9-]{36}$/)
})
test('mood validation and deletion semantics work without a database', async () => {
  const calls = []
  const service = createMoodService({
    add: (...args) => calls.push(args),
    remove: async () => false,
  })
  assert.throws(() => service.add('2026-09-13', { score: 10.5 }))
  assert.deepEqual(calls, [])
  service.add('2026-09-13', { score: 8, description: '  Rested  ' })
  assert.deepEqual(calls[0], ['2026-09-13', 8, 'Rested'])
  await assert.rejects(service.remove('2026-09-13', 'missing'), {
    name: 'Error',
    message: 'El registro no existe en este día.',
  })
})
test('template service resets completion and preserves recurrence settings', () => {
  let saved
  const service = createTemplateService({
    save: (...args) => {
      saved = args
    },
  })
  service.save(
    '2026-09-13',
    { ...emptyTask, title: 'Walk', completed: true, weekdays: [1, 3] },
    '',
    false,
  )
  assert.equal(saved[0].completed, false)
  assert.deepEqual(saved[0].weekdays, [1, 3])
})
