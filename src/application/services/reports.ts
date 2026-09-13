import type { ReportRepository } from '../ports/journal-repository.d.ts'

import { validDay } from '../../domain/dates.ts'

export function createReportService(repository: ReportRepository) {
  return {
    overview: () => repository.overview(),
    async report() {
      return {
        ...(await repository.overview()),
        ...(await repository.reportExtras()),
      }
    },
    entries(start: string, end: string) {
      if (!validDay(start) || !validDay(end) || start > end)
        throw new Error('Selecciona un período válido.')
      return repository.reportEntries(start, end)
    },
  }
}
