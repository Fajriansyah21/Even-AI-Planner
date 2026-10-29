import { CalendarEvent } from '../types';

export interface GoogleEventResponse {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  hangoutLink?: string;
  htmlLink?: string;
  location?: string;
  attendees?: { email: string; displayName?: string }[];
  status?: string;
  recurrence?: string[];
}

export type ConnectionStatusType =
  | 'unconnected'
  | 'connecting'
  | 'connected_unsynced'
  | 'syncing'
  | 'sync_success'
  | 'sync_failed'
  | 'needs_reauth'
  | 'unconfirmed';

export interface CalendarDiagnosticState {
  connectionStatus: ConnectionStatusType;
  accountEmail: string | null;
  targetCalendar: string; // e.g. "primary"
  lastSyncedAt: string | null;
  queryRange: {
    start: string;
    end: string;
    timezone: string;
  };
  eventsCountGoogle: number;
  eventsCountLocal: number;
  eventsCreatedCount: number;
  eventsFailedCount: number;
  eventsUnconfirmedCount: number;
  lastErrorMessage?: string;
}

/**
 * Sanitizes error messages to prevent access tokens, bearer headers, or PII from leaking.
 */
export function sanitizeGoogleErrorMessage(status: number, rawText: string): string {
  if (status === 401) {
    return 'Token Google Calendar kedaluwarsa atau tidak valid (HTTP 401). Silakan putuskan dan sambungkan kembali akun Google Anda di Pengaturan.';
  }
  if (status === 403) {
    return 'Akses Google Calendar ditolak (HTTP 403). Pastikan izin cakupan (OAuth scope) kalender telah disetujui pada akun Google Anda.';
  }
  try {
    const parsed = JSON.parse(rawText);
    const message = parsed?.error?.message || `HTTP ${status}`;
    return message
      .replace(/ya29\.[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]')
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');
  } catch {
    return `HTTP ${status} - Layanan Google Calendar tidak dapat dihubungi secara normal.`;
  }
}

/**
 * Normalizes all-day date string (e.g. "2026-10-25") into local ISO representation
 */
function normalizeDateBoundary(dateStr: string, isEnd = false): string {
  if (dateStr.includes('T')) return dateStr;
  if (isEnd) {
    return `${dateStr}T23:59:59.000Z`;
  }
  return `${dateStr}T00:00:00.000Z`;
}

/**
 * Fetches primary calendar events from Google Calendar v3 API with pagination and query range.
 */
export async function fetchGoogleCalendarEvents(
  accessToken: string,
  timeMin?: Date,
  timeMax?: Date
): Promise<{ events: CalendarEvent[]; rangeStart: string; rangeEnd: string }> {
  if (!accessToken || !accessToken.trim()) {
    throw new Error('Token Google Calendar tidak tersedia atau kedaluwarsa (HTTP 401). Silakan hubungkan ulang.');
  }

  const minDate = timeMin || new Date(Date.now() - 7 * 86400000);
  const maxDate = timeMax || new Date(Date.now() + 30 * 86400000);
  const minIso = minDate.toISOString();
  const maxIso = maxDate.toISOString();

  let pageToken: string | undefined = undefined;
  const allEvents: CalendarEvent[] = [];
  let pageCount = 0;
  const MAX_PAGES = 10;

  do {
    pageCount++;
    const queryParams = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: minIso,
      timeMax: maxIso,
      maxResults: '250',
    });

    if (pageToken) {
      queryParams.set('pageToken', pageToken);
    }

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${queryParams.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
    } catch (netErr: any) {
      throw new Error(`Koneksi jaringan gagal saat menghubungi Google Calendar: ${netErr.message || 'Server tidak dapat dijangkau'}`);
    }

    if (!res.ok) {
      const errText = await res.text();
      const sanitized = sanitizeGoogleErrorMessage(res.status, errText);
      console.error(`Google Calendar Fetch Error [${res.status}]:`, sanitized);
      throw new Error(`Gagal membaca Google Calendar (${res.status}): ${sanitized}`);
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new Error('Respons dari Google Calendar tidak dapat diverifikasi (format JSON tidak valid).');
    }

    const items: GoogleEventResponse[] = data.items || [];

    const mapped = items
      .filter((item) => item.status !== 'cancelled')
      .map((item): CalendarEvent => {
        const isAllDay = Boolean(item.start?.date && !item.start?.dateTime);
        const startAt = item.start?.dateTime || (item.start?.date ? normalizeDateBoundary(item.start.date, false) : new Date().toISOString());
        const endAt = item.end?.dateTime || (item.end?.date ? normalizeDateBoundary(item.end.date, true) : startAt);

        return {
          id: `gcal-${item.id}`,
          provider: 'google',
          title: item.summary || '(Tanpa Judul)',
          description: item.description,
          startAt,
          endAt,
          isAllDay,
          attendees: item.attendees?.map((a) => a.displayName || a.email || '') || [],
          location: item.location,
          meetUrl: item.hangoutLink,
          htmlLink: item.htmlLink,
          isEditable: false,
          isRecurring: Boolean(item.recurrence && item.recurrence.length > 0),
          syncStatus: 'synced',
          category: 'meeting',
        };
      });

    allEvents.push(...mapped);
    pageToken = data.nextPageToken;
  } while (pageToken && pageCount < MAX_PAGES);

  return {
    events: allEvents,
    rangeStart: minIso,
    rangeEnd: maxIso,
  };
}

/**
 * Creates a scheduled event directly on Google Calendar
 * Validates non-empty ID and handles unconfirmed responses.
 */
export async function createGoogleCalendarEvent(
  accessToken: string,
  event: {
    title: string;
    description?: string;
    startAt: string;
    endAt: string;
    isAllDay?: boolean;
    timezone?: string;
    clientRequestId?: string;
  }
): Promise<{ id: string; htmlLink?: string }> {
  if (!accessToken || !accessToken.trim()) {
    throw new Error('Token Google Calendar tidak tersedia (HTTP 401). Silakan hubungkan ulang akun Google Anda.');
  }

  if (!event.title || !event.title.trim()) {
    throw new Error('Judul agenda tidak boleh kosong.');
  }

  if (!event.startAt || !event.endAt) {
    throw new Error('Waktu mulai dan selesai agenda harus ditentukan.');
  }

  const sTime = new Date(event.startAt).getTime();
  const eTime = new Date(event.endAt).getTime();
  if (isNaN(sTime) || isNaN(eTime) || eTime <= sTime) {
    throw new Error('Waktu mulai harus lebih awal dari waktu selesai.');
  }

  const tz = event.timezone || 'Asia/Jakarta';
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

  const payload: Record<string, any> = {
    summary: event.title,
    description: event.description || 'Dijadwalkan secara terstruktur oleh perencana EVEN.',
    reminders: {
      useDefault: true,
    },
  };

  if (event.isAllDay) {
    const startDateOnly = event.startAt.split('T')[0];
    const endDateOnly = event.endAt.split('T')[0];
    payload.start = { date: startDateOnly };
    payload.end = { date: endDateOnly };
  } else {
    payload.start = { dateTime: event.startAt, timeZone: tz };
    payload.end = { dateTime: event.endAt, timeZone: tz };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (netErr: any) {
    throw new Error(`Koneksi jaringan gagal saat mengirim agenda ke Google Calendar: ${netErr.message || 'Server tidak dapat dijangkau'}`);
  }

  if (!res.ok) {
    const errText = await res.text();
    const sanitized = sanitizeGoogleErrorMessage(res.status, errText);
    console.error(`Google Calendar Event Write Error [${res.status}]:`, sanitized);
    throw new Error(`Gagal menyimpan event ke Google Calendar (${res.status}): ${sanitized}`);
  }

  let created: any;
  try {
    created = await res.json();
  } catch {
    throw new Error('Respons sukses diterima dari Google Calendar tetapi format JSON tidak valid.');
  }

  // CRITICAL VALIDATION: Check for valid, non-empty event ID
  if (!created || typeof created.id !== 'string' || !created.id.trim()) {
    throw new Error('Hasil pembuatan agenda di Google Calendar tidak dapat dikonfirmasi (ID event kosong dari server Google).');
  }

  return {
    id: created.id.trim(),
    htmlLink: created.htmlLink,
  };
}

/**
 * Deletes an event on Google Calendar
 */
export async function deleteGoogleCalendarEvent(
  accessToken: string,
  googleEventId: string
): Promise<void> {
  if (!accessToken || !accessToken.trim()) {
    throw new Error('Token Google Calendar tidak tersedia.');
  }

  const cleanId = googleEventId.replace(/^gcal-/, '');
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${cleanId}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (netErr: any) {
    throw new Error(`Koneksi jaringan terputus saat menghapus agenda: ${netErr.message}`);
  }

  // 404 is considered successfully deleted (already gone)
  if (!res.ok && res.status !== 404) {
    const errText = await res.text();
    const sanitized = sanitizeGoogleErrorMessage(res.status, errText);
    console.error(`Google Calendar Event Delete Error [${res.status}]:`, sanitized);
    throw new Error(`Gagal menghapus event dari Google Calendar (${res.status}): ${sanitized}`);
  }
}

export interface BatchCreateEventItem {
  id: string; // local session or task id
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  timezone?: string;
  isAllDay?: boolean;
}

export interface BatchCreateResult {
  success: boolean;
  totalRequested: number;
  successfulCount: number;
  failedCount: number;
  results: Array<{
    localId: string;
    googleCalendarEventId?: string;
    htmlLink?: string;
    error?: string;
  }>;
}

/**
 * Mengunggah agenda masa depan ke Google Calendar secara efisien dalam chunk batch
 * untuk menghemat kuota API Google Calendar dan meminimalkan latensi jaringan.
 */
export async function batchCreateGoogleCalendarEvents(
  accessToken: string,
  events: BatchCreateEventItem[],
  chunkSize: number = 5
): Promise<BatchCreateResult> {
  if (!accessToken || !accessToken.trim()) {
    throw new Error('Token Google Calendar tidak tersedia (HTTP 401). Silakan hubungkan ulang akun Google Anda.');
  }

  if (!events || events.length === 0) {
    return {
      success: true,
      totalRequested: 0,
      successfulCount: 0,
      failedCount: 0,
      results: [],
    };
  }

  const results: Array<{
    localId: string;
    googleCalendarEventId?: string;
    htmlLink?: string;
    error?: string;
  }> = [];

  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    const chunkPromises = chunk.map(async (ev) => {
      try {
        const created = await createGoogleCalendarEvent(accessToken, {
          title: ev.title,
          description: ev.description,
          startAt: ev.startAt,
          endAt: ev.endAt,
          timezone: ev.timezone,
          isAllDay: ev.isAllDay,
        });
        return {
          localId: ev.id,
          googleCalendarEventId: created.id,
          htmlLink: created.htmlLink,
        };
      } catch (err: any) {
        return {
          localId: ev.id,
          error: err.message || 'Gagal menyimpan agenda ke Google Calendar.',
        };
      }
    });

    const chunkResults = await Promise.all(chunkPromises);
    results.push(...chunkResults);

    if (i + chunkSize < events.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const successfulCount = results.filter((r) => Boolean(r.googleCalendarEventId)).length;
  const failedCount = results.filter((r) => Boolean(r.error)).length;

  return {
    success: successfulCount > 0,
    totalRequested: events.length,
    successfulCount,
    failedCount,
    results,
  };
}
