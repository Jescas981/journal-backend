export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—'
  if (hours > 0 && hours * 60 < 1) return '< 1 min'
  const totalMinutes = Math.round(hours * 60)
  const wholeHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (!wholeHours) return `${minutes} min`
  return minutes ? `${wholeHours} h ${minutes} min` : `${wholeHours} h`
}
