import { CalendarEvent } from '../types';

export interface GoogleEventResponse {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  location?: string;
  attendees?: { email: string; displayName?: string }[];
  status?: string;
  recurrence?: string[];
}

/**
 * Fetches primary calendar events from Google Calendar v3 API
 */
export async function fetchGoogleCalendarEvents(
  accessToken: string,
  timeMin?: Date,
  timeMax?: Date
): Promise<CalendarEvent[]> {
  const min = (timeMin || new Date(Date.now() - 7 * 86400000)).toISOString();
  const max = (timeMax || new Date(Date.now() + 21 * 86400000)).toISOString();

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(
    min
  )}&timeMax=${encodeURIComponent(max)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Google Calendar API error (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  const items: GoogleEventResponse[] = data.items || [];

  return items
    .filter((item) => item.status !== 'cancelled')
    .map((item) => {
      const start = item.start?.dateTime || item.start?.date || new Date().toISOString();
      const end = item.end?.dateTime || item.end?.date || new Date().toISOString();

      return {
        id: `gcal-${item.id}`,
        provider: 'google',
        title: item.summary || '(Tanpa Judul)',
        description: item.description,
        startAt: start,
        endAt: end,
        isAllDay: !item.start?.dateTime,
        attendees: item.attendees?.map((a) => a.displayName || a.email) || [],
        location: item.location,
        meetUrl: item.hangoutLink,
        isEditable: false,
        isRecurring: Boolean(item.recurrence && item.recurrence.length > 0),
        syncStatus: 'synced',
        category: 'meeting',
      };
    });
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
  }
): Promise<{ id: string; htmlLink?: string }> {
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

  const payload = {
    summary: event.title,
    description: event.description || 'Dijadwalkan secara otomatis oleh perencana EVEN.',
    start: {
      dateTime: event.startAt,
    },
    end: {
      dateTime: event.endAt,
    },
    reminders: {
      useDefault: true,
    },
  };

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
    throw new Error(`Gagal menyimpan event ke Google Calendar (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Deletes an event on Google Calendar
 */
export async function deleteGoogleCalendarEvent(
  accessToken: string,
  googleEventId: string
): Promise<void> {
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
    throw new Error(`Gagal menghapus event dari Google Calendar (${res.status}): ${errText}`);
  }
}
