import type { JournalRepository } from './ports/journal-repository.d.ts'

import {
  createJournalService,
  createMoodService,
  createReflectionService,
} from './services/entries.ts'
import { createGoalService } from './services/goals.ts'
import { createImageService } from './services/images.ts'
import { createReportService } from './services/reports.ts'
import { createTaskService } from './services/tasks.ts'
import { createTemplateService } from './services/templates.ts'

export function createServices(repository: JournalRepository) {
  return {
    tasks: createTaskService(repository),
    goals: createGoalService(repository),
    templates: createTemplateService(repository.templates),
    journals: createJournalService(repository.journals),
    moods: createMoodService(repository.moods),
    reflections: createReflectionService(repository.reflections),
    images: createImageService(repository.images),
    reports: createReportService(repository),
  }
}
