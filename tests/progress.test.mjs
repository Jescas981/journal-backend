import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createStore } from './fixtures/store.mjs'
import {
  emptyTask,
  qualityHours,
  objectiveProgress,
} from '../src/domain/models.ts'

test('quality hours average the factors and only completed tasks contribute', () => {
  const task = {
    ...emptyTask,
    id: 'task',
    day: '2026-09-05',
    title: 'Study',
    hours: 4,
    importance: 5,
    depth: 8,
    impact: 5,
    objectiveId: 'example-objective',
  }
  const objective = {
    id: 'example-objective',
    goalId: 'example-goal',
    title: 'Example objective 1',
    targetHours: 4,
  }
  assert.ok(Math.abs(qualityHours(task) - 2.4) < 1e-10)
  assert.equal(objectiveProgress(objective, [task]).earned, 0)
  const progress = objectiveProgress(objective, [
    { ...task, completed: true },
    { ...task, id: 'other', objectiveId: 'other', completed: true },
  ])
  assert.ok(Math.abs(progress.earned - 2.4) < 1e-10)
  assert.ok(Math.abs(progress.percent - 60) < 1e-10)
  assert.equal(progress.completed, 1)
  assert.equal(
    objectiveProgress({ ...objective, targetHours: null }, []).percent,
    null,
  )
  assert.equal(
    objectiveProgress({ ...objective, targetHours: 0.1 }, [
      { ...task, completed: true },
    ]).percent,
    100,
  )
  assert.ok(qualityHours({ ...task, impact: 0 }) > 0)
  assert.equal(qualityHours({ ...task, importance: 0, depth: 0, impact: 0 }), 0)
  assert.equal(
    qualityHours({ ...task, importance: 10, depth: 10, impact: 10 }),
    4,
  )
  assert.equal(qualityHours({ ...task, hours: 0 }), 0)
  assert.ok(
    Math.abs(
      qualityHours({
        ...task,
        hours: 1,
        importance: 8,
        depth: 5,
        impact: 9,
      }) - 0.7333333333333333,
    ) < 1e-10,
  )
})

test('migration preserves existing tasks, assignments persist, initial goals seed only once', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-store-`)
  const path = `${directory}/journal.sqlite`
  const old = new DatabaseSync(path)
  old.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, day TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', completed INTEGER NOT NULL DEFAULT 0, milestone INTEGER NOT NULL DEFAULT 0)",
  )
  old
    .prepare(
      'INSERT INTO tasks (id, day, title, completed) VALUES (?, ?, ?, ?)',
    )
    .run('old', '2026-09-05', 'Existing task', 1)
  old.close()
  let store = createStore(path)
  try {
    const migrated = store.tasks('2026-09-05')[0]
    assert.equal(migrated.title, 'Existing task')
    assert.equal(migrated.completed, true)
    assert.equal(migrated.objectiveId, null)
    assert.equal(migrated.hours, 0)
    assert.equal(store.overview().goals.length, 1)
    assert.equal(store.overview().objectives.length, 4)
    const goal = store.saveGoal(
      { id: 'next-year', title: 'Next year', year: 2027 },
      false,
    )
    const objective = store.saveObjective(
      {
        id: 'next-objective',
        goalId: goal.id,
        title: 'Learn',
        targetHours: 10,
      },
      false,
    )
    store.saveTask(
      '2026-09-05',
      {
        ...emptyTask,
        title: 'Practice',
        objectiveId: objective.id,
        hours: 2,
        importance: 10,
        depth: 5,
        impact: 10,
        completed: true,
      },
      'practice',
    )
    assert.equal(store.tasks('2026-09-06').length, 0)
    assert.throws(() =>
      store.saveTask(
        '2026-09-06',
        { ...emptyTask, title: 'Wrong day' },
        'practice',
        true,
      ),
    )
    assert.throws(() =>
      store.saveTask('2026-09-05', {
        ...emptyTask,
        title: 'Missing objective',
        objectiveId: 'missing',
      }),
    )
    store.saveGoal(
      { id: 'example-goal', title: 'Example goal edited', year: 2027 },
      true,
    )
    store.close()
    store = createStore(path)
    assert.equal(store.overview().goals.length, 2)
    assert.equal(
      store.overview().goals.find((item) => item.id === 'example-goal').title,
      'Example goal edited',
    )
    const persisted = store
      .tasks('2026-09-05')
      .find((task) => task.id === 'practice')
    assert.equal(persisted.objectiveId, objective.id)
    assert.ok(Math.abs(qualityHours(persisted) - 5 / 3) < 1e-10)
    store.saveObjective({ ...objective, targetHours: 5 }, true)
    assert.equal(
      store.overview().objectives.find((item) => item.id === objective.id)
        .targetHours,
      5,
    )
    store.deleteTask('2026-09-06', 'practice')
    assert.equal(store.tasks('2026-09-05').length, 2)
    store.deleteTask('2026-09-05', 'practice')
    assert.equal(store.tasks('2026-09-05').length, 1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('saving a sheet is atomic and cannot overwrite another day', () => {
  const store = createStore(':memory:')
  const day = '2026-09-05'
  try {
    store.saveTask(day, { ...emptyTask, title: 'Original' }, 'original')
    store.saveTask(
      '2026-09-06',
      { ...emptyTask, title: 'Another day' },
      'other',
    )
    const row = {
      ...emptyTask,
      day,
      id: 'new',
      title: 'Updated sheet',
      completed: true,
      hours: 2,
      importance: 10,
      depth: 10,
      impact: 10,
    }
    assert.throws(() =>
      store.saveDay(day, [
        row,
        { ...row, id: 'invalid', objectiveId: 'missing' },
      ]),
    )
    assert.equal(store.tasks(day)[0].title, 'Original')
    assert.throws(() => store.saveDay(day, [{ ...row, id: 'other' }]))
    assert.equal(store.tasks('2026-09-06')[0].title, 'Another day')
    assert.equal(store.tasks(day)[0].title, 'Original')
    const saved = store.saveDay(day, [row])
    assert.equal(saved.length, 1)
    assert.equal(saved[0].title, row.title)
    assert.equal(saved[0].completed, true)
    assert.equal(qualityHours(saved[0]), 2)
    store.saveDay(day, [])
    assert.equal(store.tasks(day).length, 0)
    assert.equal(store.tasks('2026-09-06').length, 1)
  } finally {
    store.close()
  }
})

test('dashboard includes zero objectives and sums only completed tasks in the selected period', async () => {
  const { dashboardMetrics, periodRange, movePeriod } =
    await import('../src/domain/dashboardMetrics.ts')
  assert.deepEqual(periodRange('2026-09-06', 'week'), {
    start: '2026-08-31',
    end: '2026-09-06',
  })
  assert.deepEqual(periodRange('2024-02-15', 'month'), {
    start: '2024-02-01',
    end: '2024-02-29',
  })
  assert.equal(movePeriod('2026-01-31', 'month', 1), '2026-02-01')
  assert.equal(movePeriod('2026-01-01', 'week', -1), '2025-12-22')
  const task = {
    ...emptyTask,
    id: 'task',
    day: '2026-09-01',
    title: 'Study',
    objectiveId: 'one',
    completed: true,
    hours: 4,
    importance: 5,
    depth: 10,
    impact: 10,
  }
  const data = {
    goals: [{ id: 'goal', title: 'Goal', year: 2025 }],
    objectives: [
      { id: 'one', title: 'One', goalId: 'goal', targetHours: null },
      { id: 'zero', title: 'Zero', goalId: 'goal', targetHours: null },
    ],
    tasks: [
      task,
      { ...task, id: 'pending', completed: false },
      { ...task, id: 'before', day: '2026-08-30' },
      { ...task, id: 'after', day: '2026-09-07' },
      { ...task, id: 'unassigned', objectiveId: null },
    ],
  }
  const week = dashboardMetrics(data, '2026-08-31', '2026-09-06')
  assert.equal(week.rows.length, 2)
  assert.ok(Math.abs(week.rows[0].period - 10 / 3) < 1e-10)
  assert.equal(week.rows[0].lifetime, 10)
  assert.equal(week.rows[1].period, 0)
  assert.ok(Math.abs(week.unassigned - 10 / 3) < 1e-10)
  assert.equal(week.completed, 2)
  assert.ok(Math.abs(week.periodTotal - 10 / 3) < 1e-10)
  assert.ok(
    Math.abs(
      dashboardMetrics(data, '2026-09-01', '2026-09-30').periodTotal - 20 / 3,
    ) < 1e-10,
  )
})

test('daily templates generate unique independent tasks and remember a skipped day after restart', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-recurring-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  try {
    const template = store.templates.save(
      {
        ...emptyTask,
        title: 'Barrer',
        hours: 10 / 60,
        importance: 5,
        depth: 1,
        impact: 4,
      },
      '2026-09-05',
    )
    assert.equal(store.tasks('2026-09-04').length, 0)
    const first = store.tasks('2026-09-05')[0]
    assert.equal(first.templateId, template.id)
    assert.equal(first.hours, 10 / 60)
    assert.equal(first.completed, false)
    assert.equal(store.tasks('2026-09-05').length, 1)
    assert.equal(store.tasks('2026-09-05')[0].id, first.id)
    store.saveDay('2026-09-05', [{ ...first, completed: true }])
    const second = store.tasks('2026-09-06')[0]
    assert.notEqual(second.id, first.id)
    assert.equal(second.completed, false)
    store.saveDay('2026-09-06', [])
    assert.equal(store.tasks('2026-09-06').length, 0)
    assert.equal(store.tasks('2026-09-07').length, 1)
    store.close()
    store = createStore(path)
    assert.equal(store.templates.list('2026-09-07')[0].title, 'Barrer')
    assert.equal(store.tasks('2026-09-05')[0].completed, true)
    assert.equal(store.tasks('2026-09-06').length, 0)
    assert.equal(store.tasks('2026-09-07').length, 1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('template edits apply forward, preserve history and individual changes, and deletion stops recurrence', () => {
  const store = createStore(':memory:')
  try {
    const draft = { ...emptyTask, title: 'Barrer', hours: 0.25 }
    const template = store.templates.save(draft, '2026-09-01')
    const completed = store.tasks('2026-09-05')[0]
    store.saveDay('2026-09-05', [{ ...completed, completed: true }])
    const customized = store.tasks('2026-09-06')[0]
    store.saveDay('2026-09-06', [
      { ...customized, title: 'Barrer la terraza', hours: 0.5 },
    ])
    const futureId = store.tasks('2026-09-07')[0].id
    store.templates.save(
      { ...draft, title: 'Barrer y ordenar', hours: 1 / 3 },
      '2026-09-04',
      template.id,
      true,
    )
    assert.equal(store.tasks('2026-09-02')[0].title, 'Barrer')
    assert.equal(store.tasks('2026-09-04')[0].title, 'Barrer y ordenar')
    assert.equal(store.tasks('2026-09-05')[0].title, 'Barrer')
    assert.equal(store.tasks('2026-09-05')[0].completed, true)
    assert.equal(store.tasks('2026-09-06')[0].title, 'Barrer la terraza')
    assert.equal(store.tasks('2026-09-07')[0].id, futureId)
    assert.equal(store.tasks('2026-09-07')[0].hours, 1 / 3)
    store.templates.archive(template.id, '2026-09-04')
    assert.equal(store.templates.list('2026-09-04').length, 0)
    assert.equal(store.tasks('2026-09-04').length, 0)
    assert.equal(store.tasks('2026-09-05')[0].completed, true)
    assert.equal(store.tasks('2026-09-06')[0].title, 'Barrer la terraza')
    assert.equal(store.tasks('2026-09-07').length, 0)
    assert.equal(store.tasks('2026-09-08').length, 0)
    assert.equal(store.tasks('2026-09-03')[0].title, 'Barrer')
    assert.throws(() =>
      store.templates.save(draft, '2026-09-05', template.id, true),
    )
  } finally {
    store.close()
  }
})

test('failed template changes roll back and day edits/deletions do not change the template', () => {
  const store = createStore(':memory:')
  try {
    const draft = {
      ...emptyTask,
      title: 'Leer',
      objectiveId: 'example-objective-0',
      hours: 0.25,
    }
    const template = store.templates.save(draft, '2024-02-28')
    const leap = store.tasks('2024-02-29')[0]
    store.saveTask('2024-02-29', { ...leap, hours: 0.5 }, leap.id, true)
    assert.equal(store.tasks('2024-02-29')[0].hours, 0.5)
    assert.equal(store.tasks('2024-03-01')[0].hours, 0.25)
    assert.throws(() =>
      store.templates.save(
        { ...draft, objectiveId: 'missing' },
        '2024-03-01',
        template.id,
        true,
      ),
    )
    assert.equal(
      store.templates.list('2024-03-01')[0].objectiveId,
      draft.objectiveId,
    )
    assert.equal(store.tasks('2024-03-01')[0].hours, 0.25)
    const next = store.tasks('2024-03-01')[0]
    store.deleteTask('2024-03-01', next.id)
    assert.equal(store.tasks('2024-03-01').length, 0)
    store.templates.save(
      { ...draft, title: 'Leer inglés' },
      '2024-03-01',
      template.id,
      true,
    )
    assert.equal(store.tasks('2024-03-01').length, 0)
    assert.equal(store.tasks('2024-03-02')[0].title, 'Leer inglés')
    assert.equal(store.templates.list('2024-03-01').length, 1)
  } finally {
    store.close()
  }
})

test('quality factors accept 0–10 and reject invalid values', async () => {
  const { isQualityFactor } = await import('../src/domain/models.ts')
  for (const value of [0, 0.5, 5, 7.5, 10])
    assert.equal(isQualityFactor(value), true)
  for (const value of [
    -0.1,
    10.1,
    100,
    NaN,
    Infinity,
    -Infinity,
    '8',
    null,
    undefined,
  ])
    assert.equal(isQualityFactor(value), false)
  assert.equal(
    qualityHours({
      ...emptyTask,
      hours: 2,
      importance: 10,
      depth: 10,
      impact: 10,
    }),
    2,
  )
  assert.equal(
    qualityHours({
      ...emptyTask,
      hours: 2,
      importance: 5,
      depth: 5,
      impact: 5,
    }),
    1,
  )
})

test('factor migration converts all tasks and template versions once without changing quality hours', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-factor-scale-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  try {
    // Construct a legacy 0–1 database using the previous version's stored shape.
    const legacy = {
      ...emptyTask,
      title: 'Legacy',
      hours: 1,
      importance: 0.8,
      depth: 0.5,
      impact: 0.9,
    }
    store.saveTask(
      '2026-09-01',
      { ...legacy, completed: true },
      'completed-legacy',
    )
    const template = store.templates.save(legacy, '2026-09-01')
    store.templates.save(
      { ...legacy, depth: 0.7 },
      '2026-09-02',
      template.id,
      true,
    )
    const archived = store.templates.save(
      { ...legacy, title: 'Archived' },
      '2026-09-01',
    )
    store.templates.archive(archived.id, '2026-09-02')
    store.close()
    const old = new DatabaseSync(path)
    old
      .prepare('DELETE FROM migrations WHERE name = ?')
      .run('quality-factors-0-to-10')
    old.close()

    store = createStore(path)
    const completed = store
      .tasks('2026-09-01')
      .find((task) => task.id === 'completed-legacy')
    assert.deepEqual(
      [completed.importance, completed.depth, completed.impact],
      [8, 5, 9],
    )
    assert.equal(completed.hours, 1)
    assert.equal(completed.completed, true)
    assert.ok(Math.abs(qualityHours(completed) - (0.8 + 0.5 + 0.9) / 3) < 1e-10)
    const future = store
      .tasks('2026-09-03')
      .find((task) => task.templateId === template.id)
    assert.deepEqual(
      [future.importance, future.depth, future.impact],
      [8, 7, 9],
    )
    assert.equal(
      store.templates.list('2026-09-01').find((item) => item.id === archived.id)
        .importance,
      8,
    )
    assert.equal(
      store.templates.list('2026-09-01').find((item) => item.id === template.id)
        .depth,
      5,
    )
    store.saveTask(
      '2026-09-03',
      {
        ...emptyTask,
        title: 'Low factor in new scale',
        hours: 1,
        importance: 1,
        depth: 1,
        impact: 1,
      },
      'new-low',
    )
    store.close()
    store = createStore(path)
    assert.equal(
      store.tasks('2026-09-01').find((task) => task.id === 'completed-legacy')
        .importance,
      8,
    )
    assert.equal(
      store.tasks('2026-09-03').find((task) => task.id === 'new-low')
        .importance,
      1,
    )
    assert.equal(
      store.templates.list('2026-09-03').find((item) => item.id === template.id)
        .depth,
      7,
    )
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('factor migration rolls back both scales when template conversion fails', async () => {
  const { migrateFactorScale } =
    await import('../src/infrastructure/sqlite/migrations.ts')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`
      CREATE TABLE migrations (name TEXT PRIMARY KEY);
      CREATE TABLE tasks (importance REAL, depth REAL, impact REAL);
      CREATE TABLE template_versions (content TEXT);
      INSERT INTO tasks VALUES (0.8, 0.5, 0.9);
      INSERT INTO template_versions VALUES ('invalid-json');
    `)
    assert.throws(() => migrateFactorScale(db))
    assert.equal(
      db.prepare('SELECT importance FROM tasks').get().importance,
      0.8,
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM migrations').get().count,
      0,
    )
  } finally {
    db.close()
  }
})

test('daily chart includes each day, stacks objectives, and keeps unassigned hours', async () => {
  const { dailyQualityMetrics, periodRange } =
    await import('../src/domain/dashboardMetrics.ts')
  const base = {
    ...emptyTask,
    title: 'Work',
    completed: true,
    hours: 1,
    importance: 10,
    depth: 10,
    impact: 10,
    objectiveId: 'one',
  }
  const data = {
    goals: [{ id: 'goal', title: 'Goal', year: 2026 }],
    objectives: [
      { id: 'one', goalId: 'goal', title: 'One', targetHours: null },
      { id: 'zero', goalId: 'goal', title: 'Zero', targetHours: null },
    ],
    tasks: [
      { ...base, id: 'monday', day: '2026-08-31' },
      { ...base, id: 'monday-more', day: '2026-08-31', hours: 0.5 },
      { ...base, id: 'sunday', day: '2026-09-06', hours: 2 },
      {
        ...base,
        id: 'routine',
        day: '2026-09-06',
        hours: 0.25,
        objectiveId: null,
      },
      { ...base, id: 'pending', day: '2026-09-01', completed: false },
      { ...base, id: 'outside', day: '2026-09-07' },
    ],
  }
  const range = periodRange('2026-09-05', 'week')
  const week = dailyQualityMetrics(data, range.start, range.end)
  assert.equal(week.days.length, 7)
  assert.equal(week.days[0].day, '2026-08-31')
  assert.equal(week.days[6].day, '2026-09-06')
  assert.equal(week.days[0].total, 1.5)
  assert.equal(week.days[1].total, 0)
  assert.equal(week.days[6].total, 2.25)
  assert.deepEqual(week.days[6].values, [2, 0, 0.25])
  assert.equal(week.series[1].title, 'Zero')
  for (const day of week.days)
    assert.equal(
      day.values.reduce((a, b) => a + b, 0),
      day.total,
    )
  const month = dailyQualityMetrics(data, '2026-09-01', '2026-09-30')
  assert.equal(month.days.length, 30)
  assert.equal(month.days[29].day, '2026-09-30')
  assert.equal(
    month.days.reduce((sum, day) => sum + day.total, 0),
    3.25,
  )
  const leap = dailyQualityMetrics(
    { ...data, tasks: [] },
    '2024-02-01',
    '2024-02-29',
  )
  assert.equal(leap.days.length, 29)
  assert.equal(
    leap.days.every((day) => day.total === 0),
    true,
  )
})

test('explicit template application fills a past day once and preserves the recurrence start', () => {
  const store = createStore(':memory:')
  try {
    const template = store.templates.save(
      {
        ...emptyTask,
        title: 'Barrer',
        hours: 0.25,
        importance: 5,
        depth: 2,
        impact: 6,
      },
      '2026-09-05',
    )
    assert.equal(store.tasks('2026-09-01').length, 0)
    const applied = store.templates.applyToDay(
      template.id,
      '2026-09-01',
      '2026-09-05',
    )
    assert.equal(applied.added, true)
    const task = store.tasks('2026-09-01')[0]
    assert.equal(task.templateId, template.id)
    assert.equal(task.title, 'Barrer')
    assert.equal(task.completed, false)
    assert.equal(task.hours, 0.25)
    assert.equal(store.tasks('2026-09-02').length, 0)
    assert.equal(store.templates.list('2026-09-01').length, 0)
    assert.equal(store.templates.list('2026-09-05')[0].startsOn, '2026-09-05')
    assert.equal(store.tasks('2026-09-05').length, 1)
    assert.equal(store.tasks('2026-09-06').length, 1)
    store.saveDay('2026-09-01', [
      { ...task, title: 'Barrer la sala', completed: true },
    ])
    assert.deepEqual(
      store.templates.applyToDay(template.id, '2026-09-01', '2026-09-05'),
      { taskId: task.id, added: false },
    )
    assert.equal(store.tasks('2026-09-01').length, 1)
    assert.equal(store.tasks('2026-09-01')[0].completed, true)
    assert.equal(store.tasks('2026-09-01')[0].title, 'Barrer la sala')
    store.saveDay('2026-09-01', [])
    assert.equal(store.tasks('2026-09-01').length, 0)
    assert.equal(
      store.templates.applyToDay(template.id, '2026-09-01', '2026-09-05').added,
      true,
    )
    assert.equal(store.tasks('2026-09-01').length, 1)
    assert.equal(store.tasks('2026-09-01')[0].completed, false)
    store.templates.archive(template.id, '2026-09-05')
    assert.equal(store.tasks('2026-09-01').length, 1)
    assert.throws(() =>
      store.templates.applyToDay(template.id, '2026-09-02', '2026-09-05'),
    )
  } finally {
    store.close()
  }
})

test('manual template snapshots survive reload and reject invalid dates without writes', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-past-template-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  try {
    const template = store.templates.save(
      { ...emptyTask, title: 'Leer', importance: 8 },
      '2026-09-05',
    )
    assert.throws(() =>
      store.templates.applyToDay(template.id, '2026-02-30', '2026-09-05'),
    )
    assert.throws(() =>
      store.templates.applyToDay('missing', '2026-09-01', '2026-09-05'),
    )
    const result = store.templates.applyToDay(
      template.id,
      '2026-09-01',
      '2026-09-05',
    )
    store.templates.save(
      { ...emptyTask, title: 'Leer otro libro', importance: 10 },
      '2026-09-05',
      template.id,
      true,
    )
    store.close()
    store = createStore(path)
    const tasks = store.tasks('2026-09-01')
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].id, result.taskId)
    assert.equal(tasks[0].title, 'Leer')
    assert.equal(tasks[0].importance, 8)
    assert.equal(store.tasks('2026-09-02').length, 0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('mood records persist their actual timestamp and remain isolated from other entry days', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-moods-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  try {
    assert.deepEqual(store.moods.list('2026-09-01'), [])
    const before = Date.now()
    const low = store.moods.add('2026-09-01', 0)
    const high = store.moods.add('2026-09-01', 10)
    const repeated = store.moods.add('2026-09-01', 10)
    assert.ok(Date.parse(low.recordedAt) >= before)
    assert.ok(Date.parse(low.recordedAt) <= Date.now())
    assert.equal(low.day, '2026-09-01')
    assert.equal(low.score, 0)
    assert.equal(high.score, 10)
    assert.notEqual(high.id, repeated.id)
    assert.equal(store.moods.list('2026-09-01')[0].id, repeated.id)
    assert.equal(store.moods.list('2026-09-01').length, 3)
    assert.equal(store.moods.list('2026-09-02').length, 0)
    assert.equal(store.moods.remove('2026-09-02', high.id), false)
    store.saveDay('2026-09-01', [])
    assert.equal(store.moods.list('2026-09-01').length, 3)
    store.close()
    store = createStore(path)
    assert.equal(
      store.moods.list('2026-09-01').find((record) => record.id === low.id)
        .recordedAt,
      low.recordedAt,
    )
    assert.equal(store.moods.remove('2026-09-01', high.id), true)
    assert.equal(store.moods.remove('2026-09-01', high.id), false)
    assert.equal(store.moods.list('2026-09-01').length, 2)
    store.close()
    store = createStore(path)
    assert.equal(
      store.moods.list('2026-09-01').some((record) => record.id === high.id),
      false,
    )
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('mood records reject scores outside the integer 0–10 scale and invalid dates', () => {
  const store = createStore(':memory:')
  try {
    for (const value of [-1, 11, 5.5, NaN, Infinity, '5', null, undefined]) {
      assert.throws(() => store.moods.add('2026-09-01', value))
    }
    assert.throws(() => store.moods.add('2026-02-30', 5))
    assert.throws(() => store.moods.list('invalid'))
    assert.equal(store.moods.list('2026-09-01').length, 0)
    assert.equal(store.moods.add('2026-09-01', 5).score, 5)
  } finally {
    store.close()
  }
})

test('journals preserve free text, persist edits and remain scoped to their entry date', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-writing-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  try {
    const body =
      'Primera reflexión 🌱\n\n  Quiero conservar los espacios.\n<script>texto, no HTML</script>'
    const first = store.journals.save('2026-09-01', '  Un buen día  ', body)
    const second = store.journals.save(
      '2026-09-01',
      'Otra reflexión',
      'Un segundo momento.',
    )
    assert.equal(first.title, 'Un buen día')
    assert.equal(first.body, body)
    assert.equal(store.journals.list('2026-09-01').length, 2)
    assert.equal(store.journals.list('2026-09-02').length, 0)
    assert.throws(() =>
      store.journals.save('2026-09-02', 'Incorrecto', 'Otro día', first.id),
    )
    assert.equal(store.journals.remove('2026-09-02', first.id), false)
    const updated = store.journals.save(
      '2026-09-01',
      'Nueva perspectiva',
      body + '\nUna idea más.',
      first.id,
    )
    assert.equal(updated.createdAt, first.createdAt)
    assert.equal(updated.id, first.id)
    store.saveDay('2026-09-01', [])
    store.moods.add('2026-09-01', 8)
    assert.equal(store.journals.list('2026-09-01').length, 2)
    store.close()
    store = createStore(path)
    assert.equal(
      store.journals.list('2026-09-01').find((record) => record.id === first.id)
        .body,
      updated.body,
    )
    assert.equal(store.journals.remove('2026-09-01', second.id), true)
    store.close()
    store = createStore(path)
    assert.equal(store.journals.list('2026-09-01').length, 1)
    assert.equal(store.moods.list('2026-09-01').length, 1)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('journal validation rejects blank or oversized content and impossible dates', () => {
  const store = createStore(':memory:')
  try {
    for (const title of ['', '  ', null, 5, 'a'.repeat(201)])
      assert.throws(() =>
        store.journals.save('2026-09-01', title, 'Reflection'),
      )
    for (const body of ['', '\n ', null, 5, 'a'.repeat(100_001)])
      assert.throws(() => store.journals.save('2026-09-01', 'Title', body))
    assert.throws(() =>
      store.journals.save('2026-02-30', 'Title', 'Reflection'),
    )
    assert.equal(store.journals.list('2026-09-01').length, 0)
  } finally {
    store.close()
  }
})

test('entry images retain their bytes and timestamp, survive restart and delete only from their day', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-images-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=',
    'base64',
  )
  try {
    const before = Date.now()
    const record = store.images.add('2026-09-01', 'Motivación.png', png)
    assert.equal(record.mimeType, 'image/png')
    assert.equal(record.size, png.length)
    assert.ok(Date.parse(record.uploadedAt) >= before)
    assert.ok(Date.parse(record.uploadedAt) <= Date.now())
    assert.equal(store.images.list('2026-09-01').length, 1)
    assert.equal('data' in store.images.list('2026-09-01')[0], false)
    assert.equal(store.images.list('2026-09-02').length, 0)
    assert.equal(store.images.get('2026-09-02', record.id), undefined)
    assert.equal(store.images.remove('2026-09-02', record.id), false)
    store.saveDay('2026-09-01', [])
    store.close()
    store = createStore(path)
    assert.deepEqual(
      Buffer.from(store.images.get('2026-09-01', record.id).data),
      png,
    )
    assert.equal(
      store.images.list('2026-09-01')[0].uploadedAt,
      record.uploadedAt,
    )
    assert.equal(store.images.remove('2026-09-01', record.id), true)
    assert.equal(store.images.get('2026-09-01', record.id), undefined)
    store.close()
    store = createStore(path)
    assert.deepEqual(store.images.list('2026-09-01'), [])
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('image uploads reject unsupported content, empty/oversized data and invalid dates', async () => {
  const { MAX_IMAGE_BYTES } =
    await import('../src/infrastructure/sqlite/images.ts')
  const store = createStore(':memory:')
  try {
    assert.throws(() =>
      store.images.add(
        '2026-09-01',
        'fake.png',
        Buffer.from('<svg onload="alert(1)"></svg>'),
      ),
    )
    assert.throws(() =>
      store.images.add('2026-09-01', 'empty.png', Buffer.alloc(0)),
    )
    assert.throws(() =>
      store.images.add(
        '2026-09-01',
        'big.png',
        Buffer.alloc(MAX_IMAGE_BYTES + 1),
      ),
    )
    assert.throws(() =>
      store.images.add('2026-02-30', 'image.png', Buffer.from('no-image')),
    )
    assert.equal(store.images.list('2026-09-01').length, 0)
  } finally {
    store.close()
  }
})

test('score templates persist and recurring tasks preserve individual score choices', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-scores-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  try {
    const draft = {
      ...emptyTask,
      title: 'Descanso',
      scoreTemplate: 'recovery',
      hours: 2,
      importance: 6,
      depth: 9,
      impact: 6,
    }
    const template = store.templates.save(draft, '2026-09-05')
    const task = store.tasks('2026-09-05')[0]
    assert.equal(task.scoreTemplate, 'recovery')
    assert.equal(qualityHours(task), 1.4)
    store.saveDay(task.day, [{ ...task, scoreTemplate: 'personal' }])
    store.templates.save(
      { ...draft, scoreTemplate: 'work' },
      task.day,
      template.id,
      true,
    )
    assert.equal(store.tasks(task.day)[0].scoreTemplate, 'personal')
    assert.equal(store.tasks('2026-09-06')[0].scoreTemplate, 'work')
    assert.throws(
      () => store.saveTask(task.day, { ...draft, scoreTemplate: 'invalid' }),
      /score/,
    )
    assert.throws(
      () =>
        store.templates.save({ ...draft, scoreTemplate: 'invalid' }, task.day),
      /score/,
    )
    store.close()
    store = createStore(path)
    assert.equal(store.tasks(task.day)[0].scoreTemplate, 'personal')
    assert.equal(store.templates.list(task.day)[0].scoreTemplate, 'work')
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('daily reflections persist by date, allow partial answers and validate ratings', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-reflections-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  try {
    const day = '2026-09-05'
    const blank = store.reflections.get(day)
    assert.equal(blank.rating, null)
    const value = {
      ...blank,
      gratitude: 'Mi familia\n❤️',
      rating: 0,
      undone: 'Leer',
      frequentProblem: 'Distracciones',
      mainProblem: 'Organización',
    }
    store.reflections.save(day, value)
    assert.deepEqual(store.reflections.get('2026-09-04'), blank)
    for (const rating of [-1, 11, 1.5, '5']) {
      assert.throws(() => store.reflections.save(day, { ...value, rating }))
    }
    assert.throws(() => store.reflections.save('2026-02-30', value))
    assert.throws(() =>
      store.reflections.save(day, { ...value, actions: 'a'.repeat(2001) }),
    )
    store.saveDay(day, [])
    store.close()
    store = createStore(path)
    assert.deepEqual(store.reflections.get(day), value)
    store.reflections.save(day, { ...value, rating: 10 })
    assert.equal(store.reflections.get(day).rating, 10)
    store.reflections.save(day, blank)
    assert.deepEqual(store.reflections.get(day), blank)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('image crop persists independently of original bytes and rejects invalid or cross-day changes', () => {
  const directory = mkdtempSync(`${tmpdir()}/journal-crop-`)
  const path = `${directory}/journal.sqlite`
  let store = createStore(path)
  try {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=',
      'base64',
    )
    const image = store.images.add('2026-09-05', 'test.png', bytes)
    store.images.crop(image.day, image.id, 2, 20, 80)
    assert.throws(() => store.images.crop('2026-09-04', image.id, 1, 50, 50))
    for (const zoom of [-1, 0.5, 4, null, '2'])
      assert.throws(() => store.images.crop(image.day, image.id, zoom, 50, 50))
    assert.throws(() => store.images.crop(image.day, image.id, 1, 101, 50))
    store.close()
    store = createStore(path)
    assert.equal(store.images.list(image.day)[0].cropZoom, 2)
    assert.equal(store.images.list(image.day)[0].cropX, 20)
    assert.equal(store.images.list(image.day)[0].cropY, 80)
    assert.deepEqual(
      Buffer.from(store.images.get(image.day, image.id).data),
      bytes,
    )
    assert.equal(store.images.crop(image.day, image.id, 0, 50, 50).cropZoom, 0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('task durations show hours and minutes without rounding the quality score input', async () => {
  const { formatDuration } = await import('../src/domain/duration.ts')
  assert.equal(formatDuration(0.25), '15 min')
  assert.equal(formatDuration(0.75), '45 min')
  assert.equal(formatDuration(1.5), '1 h 30 min')
  assert.equal(formatDuration(2), '2 h')
  assert.equal(formatDuration(0), '0 min')
  assert.equal(formatDuration(1 / 120), '< 1 min')
  assert.equal(
    qualityHours({
      ...emptyTask,
      hours: 0.75,
      importance: 8,
      depth: 8,
      impact: 8,
    }),
    0.6000000000000001,
  )
})

test('checklist tasks and weekday templates persist without hours or a time range', () => {
  const store = createStore(':memory:')
  try {
    const draft = {
      ...emptyTask,
      kind: 'task',
      title: 'Barrer',
      hours: 3,
      startTime: '09:00',
      endTime: '12:00',
      timeZone: 'America/Lima',
      weekdays: [1, 3, 5],
    }
    const template = store.templates.save(draft, '2026-09-07')
    assert.equal(template.hours, 0)
    assert.equal(template.startTime, null)
    const monday = store.tasks('2026-09-07')[0]
    assert.equal(monday.kind, 'task')
    assert.equal(monday.hours, 0)
    assert.equal(monday.startTime, null)
    assert.equal(store.tasks('2026-09-08').length, 0)
    assert.equal(store.tasks('2026-09-09').length, 1)
    store.saveDay(monday.day, [{ ...monday, completed: true }])
    assert.equal(store.tasks(monday.day)[0].completed, true)
    assert.equal(qualityHours({ ...draft, completed: true }), 0)
    assert.throws(() =>
      store.templates.save({ ...draft, weekdays: [] }, '2026-09-07'),
    )
    assert.throws(() =>
      store.templates.save({ ...draft, weekdays: [9] }, '2026-09-07'),
    )
    store.templates.save(
      { ...draft, weekdays: [2] },
      '2026-09-08',
      template.id,
      true,
    )
    assert.equal(store.tasks('2026-09-08').length, 1)
    assert.equal(store.tasks('2026-09-09').length, 0)
    assert.equal(store.tasks('2026-09-07')[0].completed, true)
    store.templates.applyToDay(template.id, '2026-09-06', '2026-09-08')
    assert.equal(store.tasks('2026-09-06').length, 1)
    assert.throws(() =>
      store.saveTask('2026-09-07', { ...draft, kind: 'invalid' }),
    )
  } finally {
    store.close()
  }
})

test('reports exclude future entries, separate checklist counts and calculate historical objective progress', async () => {
  const { reportMetrics } = await import('../src/domain/reportMetrics.ts')
  const task = {
    ...emptyTask,
    id: 'task',
    day: '2026-09-01',
    title: 'Paper',
    completed: true,
    hours: 2,
    importance: 10,
    depth: 10,
    impact: 10,
    objectiveId: 'objective',
  }
  const data = {
    goals: [{ id: 'goal', title: 'Example goal', year: 2026 }],
    objectives: [
      { id: 'objective', goalId: 'goal', title: 'Paper', targetHours: 10 },
      { id: 'zero', goalId: 'goal', title: 'TOEFL', targetHours: null },
    ],
    tasks: [
      task,
      { ...task, id: 'older', day: '2026-08-30', hours: 3 },
      { ...task, id: 'future', day: '2026-09-30', hours: 50 },
      { ...task, id: 'check', kind: 'task', objectiveId: null },
      { ...task, id: 'pending', completed: false },
    ],
    moods: [
      { day: task.day, score: 4 },
      { day: task.day, score: 8 },
      { day: '2026-09-30', score: 10 },
    ],
    journalDays: [task.day],
    imageDays: [],
    reflectionDays: [task.day],
  }
  const report = reportMetrics(data, 'month', task.day, '2026-09-06')
  assert.equal(report.total, 3)
  assert.equal(report.completed, 2)
  assert.equal(report.checklistCompleted, 1)
  assert.equal(report.quality, 2)
  assert.equal(report.eventHours, 2)
  assert.equal(report.rows[0].accumulated, 5)
  assert.equal(report.rows[0].percent, 50)
  assert.equal(report.rows[1].quality, 0)
  assert.equal(report.moodAverage, 6)
  assert.equal(report.buckets.length, 6)
  assert.equal(report.buckets[1].value, 0)
  assert.equal(report.journals, 1)
  assert.equal(reportMetrics(data, 'all', task.day, '2026-09-06').quality, 5)
  assert.equal(
    reportMetrics(data, 'year', task.day, '2026-09-06').buckets.length,
    9,
  )
  assert.equal(
    reportMetrics(
      { ...data, tasks: [], moods: [], journalDays: [], reflectionDays: [] },
      'all',
      task.day,
      '2026-09-06',
    ).moodAverage,
    null,
  )
})

test('report entry details preserve content and timestamps within the selected dates', async () => {
  const { emptyReflection } = await import('../src/domain/models.ts')
  const store = createStore(':memory:')
  try {
    const day = '2026-09-01'
    const journal = store.journals.save(
      day,
      'Reflexión',
      'Primera línea\nSegunda línea',
    )
    const mood = store.moods.add(day, 8)
    store.reflections.save(day, {
      ...emptyReflection,
      actions: 'Descansar',
      rating: 0,
    })
    const image = store.images.add(
      day,
      'evidencia.png',
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    store.images.crop(day, image.id, 2, 25, 75)
    store.journals.save('2026-08-31', 'Anterior', 'Fuera del período')
    store.moods.add('2026-09-02', 3)
    const details = store.reportEntries(day, day)
    assert.equal(details.journals.length, 1)
    assert.equal(details.journals[0].body, journal.body)
    assert.equal(details.journals[0].createdAt, journal.createdAt)
    assert.equal(details.journals[0].updatedAt, journal.updatedAt)
    assert.equal(details.moods.length, 1)
    assert.equal(details.moods[0].recordedAt, mood.recordedAt)
    assert.equal(details.reflections[0].actions, 'Descansar')
    assert.equal(details.reflections[0].rating, 0)
    assert.equal(details.images[0].uploadedAt, image.uploadedAt)
    assert.equal(details.images[0].cropZoom, 2)
    assert.equal(details.images[0].cropX, 25)
    assert.equal(details.images[0].cropY, 75)
    assert.equal('data' in details.images[0], false)
    assert.deepEqual(store.reportEntries('2027-01-01', '2027-01-31'), {
      moods: [],
      journals: [],
      reflections: [],
      images: [],
    })
  } finally {
    store.close()
  }
})

test('mood descriptions migrate old records and validate optional text', async () => {
  const { createMoodStore } =
    await import('../src/infrastructure/sqlite/moods.ts')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE mood_records (
      id TEXT PRIMARY KEY, day TEXT NOT NULL, score INTEGER NOT NULL,
      recordedAt TEXT NOT NULL
    ); INSERT INTO mood_records VALUES ('old', '2026-09-01', 5, '2026-09-01T12:00:00Z');`)
    const moods = createMoodStore(db)
    assert.equal(moods.list('2026-09-01')[0].description, '')
    const record = moods.add(
      '2026-09-01',
      8,
      '  Terminé mi trabajo\nMe siento tranquilo.  ',
    )
    assert.equal(record.description, 'Terminé mi trabajo\nMe siento tranquilo.')
    assert.equal(
      moods.list('2026-09-01').find((item) => item.id === record.id)
        .description,
      record.description,
    )
    assert.equal(moods.add('2026-09-01', 6).description, '')
    assert.equal(moods.add('2026-09-01', 6, '   ').description, '')
    for (const invalid of [null, 12, {}, 'a'.repeat(2001)]) {
      assert.throws(() => moods.add('2026-09-01', 5, invalid))
    }
  } finally {
    db.close()
  }
})
