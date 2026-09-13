import { mkdirSync } from 'node:fs'
import { createStore } from './infrastructure/sqlite/store.ts'
import { createTaskApi } from './task-api.ts'
mkdirSync('data', { recursive: true })
export const store = createStore('data/journal.sqlite')
export const taskApi = createTaskApi(store)
