import { createStore as createEmptyStore } from '../../src/infrastructure/sqlite/store.ts'

export function createStore(path) {
  const store = createEmptyStore(path)
  if (!store.overview().goals.some((goal) => goal.id === 'example-goal')) {
    store.saveGoal(
      { id: 'example-goal', title: 'Example goal', year: 2026 },
      false,
    )
    for (let index = 0; index < 4; index++) {
      store.saveObjective(
        {
          id: `example-objective-${index}`,
          goalId: 'example-goal',
          title: `Example objective ${index + 1}`,
          targetHours: null,
        },
        false,
      )
    }
  }
  return store
}
