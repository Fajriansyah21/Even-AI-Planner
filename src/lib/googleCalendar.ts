import { CalendarEvent } from '../types';

export interface GoogleEventResponse {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  hangoutLink?: string;
  location?: string;
  attendees?: { email: string; displayName?: string }[];
  status?: string;
  recurrence?: string[];
}

/**
 * Sanitizes error messages to prevent access tokens, bearer headers, or PII from leaking in logs.
 */
function sanitizeErrorMessage(status: number, rawText: string): string {
  try {
    const parsed = JSON.parse(rawText);
    const message = parsed?.error?.message || `HTTP ${status}`;
    // Strip anything resembling bearer tokens or email addresses
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
  // If end date for all-day event in Google Calendar, it's exclusive (midnight of next day)
  // We represent it as 23:59:59 of current day or exact ISO string
  if (isEnd) {
    return `${dateStr}T23:59:59.000Z`;
  }
  return `${dateStr}T00:00:00.000Z`;
}

/**
 * Fetches primary calendar events from Google Calendar v3 API with full pagination (nextPageToken)
 */
export async function fetchGoogleCalendarEvents(
  accessToken: string,
  timeMin?: Date,
  timeMax?: Date
): Promise<CalendarEvent[]> {
  if (!accessToken || !accessToken.trim()) {
    throw new Error('Token Google Calendar tidak tersedia atau kedaluwarsa. Silakan hubungkan ulang.');
  }

  const min = (timeMin || new Date(Date.now() - 7 * 86400000)).toISOString();
  const max = (timeMax || new Date(Date.now() + 30 * 86400000)).toISOString();

  let pageToken: string | undefined = undefined;
  const allEvents: CalendarEvent[] = [];
  let pageCount = 0;
  const MAX_PAGES = 10; // safety ceiling to prevent infinite loops

  do {
    pageCount++;
    const queryParams = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: min,
      timeMax: max,
      maxResults: '250',
    });

    if (pageToken) {
      queryParams.set('pageToken', pageToken);
    }

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${queryParams.toString()}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      const sanitized = sanitizeErrorMessage(res.status, errText);
      console.error(`Google Calendar Fetch Error [${res.status}]:`, sanitized);
      throw new Error(`Gagal membaca Google Calendar (${res.status}): ${sanitized}`);
    }

    const data = await res.json();
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
          isEditable: false,
          isRecurring: Boolean(item.recurrence && item.recurrence.length > 0),
          syncStatus: 'synced',
          category: 'meeting',
        };
      });

    allEvents.push(...mapped);
    pageToken = data.nextPageToken;
  } while (pageToken && pageCount < MAX_PAGES);

  return allEvents;
}

/**
 * Creates a scheduled event directly on Google Calendar
 */
export async function createGoogleCalendarEvent(
  accessToken: string,
  event: {
    title: string;
    description?: string;
    startAt: string;
    endAt: string;
    isAllDay?: boolean;
    clientRequestId?: string;
  }
): Promise<{ id: string; htmlLink?: string }> {
  if (!accessToken || !accessToken.trim()) {
    throw new Error('Token Google Calendar tidak tersedia. Silakan hubungkan ulang akun Google Anda.');
  }

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
    payload.start = { dateTime: event.startAt };
    payload.end = { dateTime: event.endAt };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    const sanitized = sanitizeErrorMessage(res.status, errText);
    console.error(`Google Calendar Event Write Error [${res.status}]:`, sanitized);
    throw new Error(`Gagal menyimpan event ke Google Calendar (${res.status}): ${sanitized}`);
  }

  const created = await res.json();
  return {
    id: created.id,
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

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok && res.status !== 404) {
    const errText = await res.text();
    const sanitized = sanitizeErrorMessage(res.status, errText);
    console.error(`Google Calendar Event Delete Error [${res.status}]:`, sanitized);
    throw new Error(`Gagal menghapus event dari Google Calendar (${res.status}): ${sanitized}`);
  }
}
