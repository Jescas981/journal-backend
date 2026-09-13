export function dateKey(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function validDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    dateKey(new Date(`${value}T12:00:00`)) === value
  )
}

export function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString('es', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export function entryTimestamp(timestamp: string, entryDay: string): string {
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString('es', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return dateKey(date) === entryDay
    ? time
    : `${date.toLocaleDateString('es')} · ${time}`
}
