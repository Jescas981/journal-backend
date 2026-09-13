import type { Schedule } from './schedule.types.d.ts'

export function timeMinutes(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    throw new Error('Selecciona una hora válida.')
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

export function nextDay(day: string, count = 1): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + count)
  return date.toISOString().slice(0, 10)
}

// Convert a wall-clock time in an IANA timezone, without depending on the server timezone.
export function zonedInstant(
  day: string,
  time: string,
  timeZone: string,
): string {
  timeMinutes(time)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const target = Date.parse(`${day}T${time}:00Z`)
  let instant = target
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .map((part) => [part.type, part.value]),
    )
    const local = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    )
    if (local === target) return new Date(instant).toISOString()
    instant += target - local
  }
  throw new Error(
    'Ese horario no existe por el cambio de hora. Selecciona otro rango.',
  )
}

export function scheduledRange(day: string, schedule: Schedule) {
  if (!schedule.startTime && !schedule.endTime) return null
  if (!schedule.startTime || !schedule.endTime || !schedule.timeZone)
    throw new Error('Selecciona inicio, fin y zona horaria.')
  const startMinutes = timeMinutes(schedule.startTime)
  const endMinutes = timeMinutes(schedule.endTime)
  if (startMinutes === endMinutes)
    throw new Error('El inicio y el fin deben ser distintos.')
  const start = zonedInstant(day, schedule.startTime, schedule.timeZone)
  const end = zonedInstant(
    endMinutes < startMinutes ? nextDay(day) : day,
    schedule.endTime,
    schedule.timeZone,
  )
  const hours = (Date.parse(end) - Date.parse(start)) / 3600000
  if (hours <= 0) throw new Error('El rango de horas no es válido.')
  return { start, end, hours }
}
