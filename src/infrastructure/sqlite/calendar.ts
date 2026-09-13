import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CalendarEntry,
  CalendarOutbox,
  CalendarSchedule,
} from '../../domain/calendar.d.ts'
import { zonedInstant } from '../../domain/schedule.ts'
import type { Config } from './calendar.types.d.ts'

import { validDay } from '../../domain/dates.ts'

export function calendarTitle(summary: string) {
  const marker = /^(?:[✓✔✅]\uFE0F?\s*)+/u
  return {
    completed: marker.test(summary),
    title: summary.replace(marker, '').trim() || 'Evento de Calendar',
  }
}

export const calendarScope =
  'https://www.googleapis.com/auth/calendar.app.created'

export function createCalendar(
  db: DatabaseSync,
  config: Config,
  importEntries: (day: string, entries: CalendarEntry[]) => void,
  request = fetch,
  outbox?: CalendarOutbox,
  schedule?: CalendarSchedule,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_published (taskId TEXT PRIMARY KEY, eventId TEXT NOT NULL, owned INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS calendar_connection (id INTEGER PRIMARY KEY CHECK(id=1), refresh TEXT NOT NULL, calendarId TEXT);
  `)
  function key() {
    if (!config.tokenKey || !/^[a-f0-9]{64}$/i.test(config.tokenKey))
      throw new Error('Falta configurar CALENDAR_TOKEN_KEY en el servidor.')
    return Buffer.from(config.tokenKey, 'hex')
  }
  function encrypt(value: string) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key(), iv)
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      'base64',
    )
  }
  function decrypt(value: string) {
    const tokenKey = key()
    try {
      const bytes = Buffer.from(value, 'base64')
      const cipher = createDecipheriv(
        'aes-256-gcm',
        tokenKey,
        bytes.subarray(0, 12),
      )
      cipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString('utf8')
    } catch {
      throw new Error(
        'No se puede descifrar la conexión guardada de Calendar. Restaura la CALENDAR_TOKEN_KEY original o desconecta y vuelve a conectar Calendar con la clave actual.',
      )
    }
  }
  function connection() {
    return db.prepare('SELECT * FROM calendar_connection WHERE id=1').get() as
      { refresh: string; calendarId: string | null } | undefined
  }
  let access: { token: string; expires: number } | null = null
  async function accessToken() {
    if (access && access.expires > Date.now()) return access.token
    const current = connection()
    if (!current?.refresh)
      throw new Error('Conecta Google Calendar para continuar.')
    const response = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: decrypt(current.refresh),
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok)
      throw new Error(
        'Vuelve a conectar Google Calendar: el permiso ha caducado o fue revocado.',
      )
    const result = (await response.json()) as {
      access_token?: string
      expires_in?: number
    }
    if (!result.access_token)
      throw new Error('Google no devolvió un permiso válido.')
    access = {
      token: result.access_token,
      expires: Date.now() + (Number(result.expires_in || 3600) - 60) * 1000,
    }
    return access.token
  }
  async function api(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await request(
      `https://www.googleapis.com/calendar/v3/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    )
    if (response.status === 401) access = null
    if (!response.ok && ![404, 409, 410, 412].includes(response.status))
      throw new Error(
        response.status === 403
          ? 'Comprueba que Google Calendar API esté habilitada y vuelve a conectar Calendar.'
          : 'No se pudo completar la operación en Calendar. Puedes reintentar.',
      )
    return response
  }
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action)
    queue = result.catch(() => {})
    return result
  }
  async function calendarId() {
    const current = connection()
    if (current?.calendarId) return current.calendarId
    const response = await api('calendars', 'POST', {
      summary: 'Journal',
      description: 'Tareas programadas desde Journal',
    })
    const result = (await response.json()) as { id?: string }
    if (!response.ok || !result.id)
      throw new Error('No se pudo crear el calendario Journal.')
    db.prepare('UPDATE calendar_connection SET calendarId=? WHERE id=1').run(
      result.id,
    )
    return result.id
  }
  async function publishSchedule(day: string, calendar: string) {
    if (!schedule) return
    const tasks = schedule.tasks(day)
    const byId = new Map(
      tasks
        .filter(
          (task) => task.kind !== 'task' && task.startTime && task.endTime,
        )
        .map((task) => [task.id, task]),
    )
    const published = db.prepare('SELECT * FROM calendar_published').all() as {
      taskId: string
      eventId: string
      owned: number
    }[]
    for (const old of published) {
      if (byId.has(old.taskId)) continue
      if (old.owned) {
        const response = await api(
          `calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(old.eventId)}?sendUpdates=none`,
          'DELETE',
        )
        if (!response.ok && ![404, 410].includes(response.status))
          throw new Error('No se pudo retirar el evento de la tarea eliminada.')
      }
      if (old.owned) schedule.unlink?.(old.taskId, `${calendar}/${old.eventId}`)
      db.prepare('DELETE FROM calendar_published WHERE taskId=?').run(
        old.taskId,
      )
    }
    for (const change of schedule.pending()) {
      const task = byId.get(change.taskId)
      if (!task) {
        schedule.acknowledge(change.taskId, change.revision)
        continue
      }
      if (!task.startTime || !task.endTime || !task.timeZone || task.hours <= 0)
        continue
      const start = zonedInstant(task.day, task.startTime, task.timeZone)
      const range = {
        start,
        end: new Date(Date.parse(start) + task.hours * 3600000).toISOString(),
      }
      let old = db
        .prepare('SELECT * FROM calendar_published WHERE taskId=?')
        .get(task.id) as { eventId: string; owned: number } | undefined
      if (!old) {
        if (
          task.calendarEventId &&
          !task.calendarEventId.startsWith(`${calendar}/`)
        )
          throw new Error('La tarea pertenece a otro calendario.')
        old = {
          eventId: task.calendarEventId
            ? task.calendarEventId.slice(calendar.length + 1)
            : randomBytes(16).toString('hex'),
          owned: Number(!task.calendarEventId),
        }
        db.prepare('INSERT INTO calendar_published VALUES (?, ?, ?)').run(
          task.id,
          old.eventId,
          old.owned,
        )
      }
      schedule.link(task.id, `${calendar}/${old.eventId}`, task.day)
      const base = `calendars/${encodeURIComponent(calendar)}/events`
      const path = `${base}/${encodeURIComponent(old.eventId)}`
      const previous = await api(path)
      let remote: { summary?: string; etag?: string } | null = null
      if (previous.ok)
        remote = (await previous.json()) as { summary?: string; etag?: string }
      else if (previous.status !== 404)
        throw new Error(
          'El evento no está disponible. Actualiza Calendar e inténtalo de nuevo.',
        )
      const pendingCheck = outbox
        ?.pending()
        .find((item) => item.eventId === `${calendar}/${old.eventId}`)
      const completed = pendingCheck
        ? Boolean(pendingCheck.completed)
        : remote
          ? calendarTitle(remote.summary || '').completed
          : task.completed
      const body = {
        summary: `${completed ? '✓ ' : ''}${task.title}`,
        description: task.description,
        start: { dateTime: range.start, timeZone: task.timeZone },
        end: { dateTime: range.end, timeZone: task.timeZone },
      }
      if (remote && !remote.etag)
        throw new Error('Google no devolvió la versión del evento.')
      const result = remote
        ? await api(`${path}?sendUpdates=none`, 'PATCH', body, {
            'If-Match': remote.etag!,
          })
        : await api(`${base}?sendUpdates=none`, 'POST', {
            id: old.eventId,
            ...body,
            extendedProperties: { private: { journalTaskId: task.id } },
          })
      if (!result.ok)
        throw new Error(
          'No se pudo guardar el horario en Calendar. El cambio queda pendiente para reintentar.',
        )
      schedule.acknowledge(task.id, change.revision)
    }
  }

  async function pushCompletions(calendar: string) {
    for (const change of outbox?.pending() ?? []) {
      const prefix = `${calendar}/`
      if (!change.eventId.startsWith(prefix))
        throw new Error('El cambio pendiente pertenece a otro calendario.')
      const eventId = change.eventId.slice(prefix.length)
      const path = `calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`
      const response = await api(path)
      if ([404, 410].includes(response.status)) {
        outbox?.acknowledge(change)
        continue
      }
      if (!response.ok)
        throw new Error('No se pudo consultar el evento pendiente.')
      const event = (await response.json()) as {
        summary?: string
        etag?: string
        status?: string
      }
      if (event.status === 'cancelled') {
        outbox?.acknowledge(change)
        continue
      }
      const plain = calendarTitle(event.summary || 'Evento de Calendar').title
      const summary = change.completed ? `✓ ${plain}` : plain
      if (summary !== event.summary) {
        if (!event.etag)
          throw new Error(
            'Google no devolvió la versión del evento. Reintenta la sincronización.',
          )
        const updated = await api(
          `${path}?sendUpdates=none`,
          'PATCH',
          { summary },
          { 'If-Match': event.etag },
        )
        if (!updated.ok)
          throw new Error(
            'El evento cambió en Calendar. El check sigue pendiente; vuelve a actualizar.',
          )
      }
      outbox?.acknowledge(change)
    }
  }
  return {
    grant(token: { scope?: unknown; refresh_token?: unknown }) {
      if (
        typeof token.scope !== 'string' ||
        !token.scope.split(' ').includes(calendarScope)
      )
        throw new Error('No se concedió acceso a Calendar.')
      const refresh =
        typeof token.refresh_token === 'string' &&
        token.refresh_token.length > 0
          ? encrypt(token.refresh_token)
          : connection()?.refresh
      if (!refresh)
        throw new Error(
          'Vuelve a conectar Calendar para conceder acceso sin conexión.',
        )
      // Never report a successful reconnection while retaining an unreadable token.
      decrypt(refresh)
      db.prepare(
        'INSERT INTO calendar_connection (id, refresh) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET refresh=excluded.refresh',
      ).run(refresh)
      access = null
    },
    status(day: string) {
      if (!validDay(day)) throw new Error('Fecha no válida.')
      return {
        connected: Boolean(connection()?.refresh),
        calendarId: connection()?.calendarId ?? null,
      }
    },
    disconnect: () =>
      serial(async () => {
        db.prepare("UPDATE calendar_connection SET refresh='' WHERE id=1").run()
        access = null
      }),
    flush: () =>
      serial(async () => {
        const current = connection()
        if (current?.refresh && current.calendarId) {
          await publishSchedule(
            new Date().toLocaleDateString('en-CA', {
              timeZone: 'America/Lima',
            }),
            current.calendarId,
          )
          await pushCompletions(current.calendarId)
        }
      }),
    initialize: () => serial(async () => ({ calendarId: await calendarId() })),
    sync: (day: string, timeZone: string) =>
      serial(async () => {
        if (!validDay(day)) throw new Error('Fecha no válida.')
        // Validate the browser's IANA timezone before using it to classify events.
        const formatter = new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        })
        const id = connection()?.calendarId
        if (!id || !connection()?.refresh)
          throw new Error('Conecta y crea el calendario Journal primero.')
        await publishSchedule(day, id)
        await pushCompletions(id)
        const middle = Date.parse(`${day}T12:00:00Z`)
        const entries: CalendarEntry[] = []
        let pageToken = ''
        do {
          const query = new URLSearchParams({
            timeMin: new Date(middle - 36 * 3600000).toISOString(),
            timeMax: new Date(middle + 36 * 3600000).toISOString(),
            singleEvents: 'true',
            maxResults: '2500',
            timeZone,
          })
          if (pageToken) query.set('pageToken', pageToken)
          const response = await api(
            `calendars/${encodeURIComponent(id)}/events?${query}`,
          )
          if (!response.ok)
            throw new Error(
              'No se pudo leer el calendario Journal. Comprueba que siga existiendo en Google.',
            )
          const result = (await response.json()) as {
            items?: Array<{
              id?: string
              status?: string
              summary?: string
              description?: string
              start?: { dateTime?: string }
              end?: { dateTime?: string }
            }>
            nextPageToken?: string
          }
          if (!Array.isArray(result.items))
            throw new Error('Google devolvió una lista de eventos no válida.')
          for (const event of result.items) {
            if (
              event.status === 'cancelled' ||
              !event.id ||
              !event.start?.dateTime ||
              !event.end?.dateTime
            )
              continue
            const start = new Date(event.start.dateTime)
            const end = new Date(event.end.dateTime)
            if (
              !Number.isFinite(start.getTime()) ||
              !Number.isFinite(end.getTime())
            )
              continue
            const parts = formatter.formatToParts(start)
            const eventDay = ['year', 'month', 'day']
              .map((type) => parts.find((part) => part.type === type)?.value)
              .join('-')
            const hours = (end.getTime() - start.getTime()) / 3600000
            if (eventDay !== day || hours <= 0) continue
            const clock = (date: Date) =>
              new Intl.DateTimeFormat('en-GB', {
                timeZone,
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
              }).format(date)
            entries.push({
              startTime: clock(start),
              endTime: clock(end),
              timeZone,
              eventId: `${id}/${event.id}`,
              title: calendarTitle(
                event.summary || 'Evento de Calendar',
              ).title.slice(0, 200),
              completed: calendarTitle(event.summary || '').completed,
              description: (event.description || '').slice(0, 5000),
              hours,
            })
          }
          pageToken = result.nextPageToken || ''
        } while (pageToken)
        importEntries(day, entries)
        return { ok: true, imported: entries.length }
      }),
  }
}
