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

export type GoogleCalendarErrorCode =
  | 'AUTH_EXPIRED_OR_INVALID' // HTTP 401: Token invalid or expired
  | 'PERMISSION_DENIED'       // HTTP 403: Scope or calendar access not permitted
  | 'API_NOT_CONFIGURED'      // HTTP 403: Google Calendar API disabled / not configured in Cloud project
  | 'NOT_FOUND'               // HTTP 404: Resource or primary calendar not found
  | 'RATE_LIMIT_EXCEEDED'     // HTTP 429 atau 403: API quota or rate limit exceeded
  | 'SERVICE_UNAVAILABLE'     // HTTP 500-599: Google service temporary failure
  | 'NETWORK_ERROR'           // Fetch / TCP connection dropped
  | 'ABORTED'                 // Request aborted by controller
  | 'INVALID_RESPONSE'        // Non-JSON or missing required event ID
  | 'PAGINATION_LIMIT_EXCEEDED' // Max pages reached with pageToken remaining
  | 'UNKNOWN_ERROR';          // Other unexpected errors

export interface GoogleCalendarErrorClassification {
  code: GoogleCalendarErrorCode;
  status: number;
  isAuthError: boolean;
  isPermissionError: boolean;
  isRateLimitError: boolean;
  isTransient: boolean;
  shouldReauth: boolean;
  message: string;
  userAction: string;
}

/**
 * Custom Error class with classified metadata and sanitized message.
 */
export class GoogleCalendarApiError extends Error {
  public readonly classification: GoogleCalendarErrorClassification;

  constructor(classification: GoogleCalendarErrorClassification) {
    super(classification.message);
    this.name = 'GoogleCalendarApiError';
    this.classification = classification;
    Object.setPrototypeOf(this, GoogleCalendarApiError.prototype);
  }

  get code(): GoogleCalendarErrorCode {
    return this.classification.code;
  }

  get status(): number {
    return this.classification.status;
  }

  get isAuthError(): boolean {
    return this.classification.isAuthError;
  }

  get isPermissionError(): boolean {
    return this.classification.isPermissionError;
  }

  get isRateLimitError(): boolean {
    return this.classification.isRateLimitError;
  }

  get isTransient(): boolean {
    return this.classification.isTransient;
  }

  get shouldReauth(): boolean {
    return this.classification.shouldReauth;
  }
}

/**
 * Sanitizes any text to prevent access tokens, refresh tokens, Bearer headers, query params, or PII from leaking.
 */
export function sanitizeSensitiveText(text: string): string {
  if (!text) return '';
  return String(text)
    // Google OAuth access tokens (ya29.xxx)
    .replace(/ya29\.[a-zA-Z0-9_\-.]+/g, '[REDACTED_TOKEN]')
    // Google OAuth refresh tokens (1//xxx)
    .replace(/1\/\/[a-zA-Z0-9_\-.]+/g, '[REDACTED_REFRESH_TOKEN]')
    // Authorization: Bearer <token>
    .replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED]')
    // Email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    // Sensitive URL query parameters: ?access_token=..., &refresh_token=..., &client_secret=..., &key=..., &code=..., &token=..., &apiKey=...
    .replace(/([?&](?:access_token|refresh_token|token|client_secret|client_id|apiKey|key|code|auth)=)[^&\s]+/gi, '$1[REDACTED]')
    // JSON / key-value format e.g. "access_token": "secret" or 'client_secret': 'abc'
    .replace(/(["']?(?:access_token|refresh_token|client_secret|apiKey)["']?\s*[:=]\s*["']?)[^"',\s&}]+/gi, '$1[REDACTED]');
}

/**
 * Sanitizes error messages to prevent access tokens, bearer headers, or PII from leaking.
 */
export function sanitizeGoogleErrorMessage(status: number, rawText: string): string {
  if (status === 401) {
    return 'Token Google Calendar kedaluwarsa atau tidak valid (HTTP 401). Silakan putuskan dan sambungkan kembali akun Google Anda di Pengaturan.';
  }
  if (status === 403) {
    if (/userRateLimitExceeded|rateLimitExceeded|quotaExceeded|calendarUsageLimitsExceeded|dailyLimitExceeded|limitExceeded/i.test(rawText)) {
      return 'Batas kuota atau laju panggilan Google Calendar terlampaui (HTTP 403). Mohon tunggu beberapa saat sebelum mencoba kembali.';
    }
    if (/accessNotConfigured/i.test(rawText)) {
      return 'Google Calendar API belum diaktifkan atau belum dikonfigurasi pada proyek Google Cloud pengembang.';
    }
    if (/insufficientPermissions|forbidden/i.test(rawText)) {
      return 'Akses Google Calendar ditolak (HTTP 403). Pastikan izin cakupan (OAuth scope) kalender telah disetujui pada akun Google Anda.';
    }
    return 'Akses Google Calendar dibatasi atau ditolak oleh server Google (HTTP 403). Silakan periksa status layanan Google atau coba beberapa saat lagi.';
  }
  if (status === 404) {
    return 'Kalender atau agenda tidak ditemukan di Google Calendar (HTTP 404). Data lokal Anda tetap aman.';
  }
  if (status === 429) {
    return 'Batas panggilan API Google Calendar terlampaui (HTTP 429). Mohon tunggu beberapa saat sebelum mencoba kembali.';
  }
  if (status >= 500 && status <= 599 && (!rawText || !rawText.trim().startsWith('{'))) {
    return `Layanan Google Calendar sedang mengalami gangguan sementara (HTTP ${status}). Data lokal tetap tersimpan.`;
  }

  try {
    const parsed = JSON.parse(rawText);
    const message = parsed?.error?.message || `HTTP ${status}`;
    return sanitizeSensitiveText(message);
  } catch {
    const cleaned = sanitizeSensitiveText(rawText);
    if (status >= 500 && status <= 599) {
      return `Layanan Google Calendar sedang mengalami gangguan sementara (HTTP ${status}). Data lokal tetap tersimpan.`;
    }
    return `HTTP ${status} - ${cleaned || 'Layanan Google Calendar tidak dapat dihubungi secara normal.'}`;
  }
}

/**
 * Centralized Google Calendar API Error Classifier
 */
export function classifyGoogleCalendarError(
  status: number,
  rawBody: string,
  originalError?: any
): GoogleCalendarErrorClassification {
  const sanitizedOriginalMsg = sanitizeSensitiveText(originalError?.message || '');

  // Check AbortError
  if (originalError?.name === 'AbortError' || sanitizedOriginalMsg.toLowerCase().includes('aborted')) {
    return {
      code: 'ABORTED',
      status: 0,
      isAuthError: false,
      isPermissionError: false,
      isRateLimitError: false,
      isTransient: false,
      shouldReauth: false,
      message: 'Permintaan ke Google Calendar dibatalkan oleh pengguna.',
      userAction: 'Coba ulangi operasi jika Anda membatalkannya secara tidak sengaja.',
    };
  }

  // Check Network Error
  if (
    status === 0 ||
    originalError?.name === 'TypeError' ||
    sanitizedOriginalMsg.toLowerCase().includes('failed to fetch') ||
    sanitizedOriginalMsg.toLowerCase().includes('network') ||
    sanitizedOriginalMsg.toLowerCase().includes('koneksi jaringan')
  ) {
    return {
      code: 'NETWORK_ERROR',
      status: 0,
      isAuthError: false,
      isPermissionError: false,
      isRateLimitError: false,
      isTransient: true,
      shouldReauth: false,
      message: `Koneksi jaringan gagal saat menghubungi Google Calendar: ${sanitizedOriginalMsg || 'Server tidak dapat dijangkau'}. Data lokal tetap aman.`,
      userAction: 'Periksa koneksi internet Anda dan coba kembali sinkronisasi.',
    };
  }

  // HTTP 401: Unauthorized / Expired Token
  if (status === 401) {
    return {
      code: 'AUTH_EXPIRED_OR_INVALID',
      status: 401,
      isAuthError: true,
      isPermissionError: false,
      isRateLimitError: false,
      isTransient: false,
      shouldReauth: true,
      message: 'Token Google Calendar kedaluwarsa atau tidak valid (HTTP 401). Silakan hubungkan ulang akun Google Anda.',
      userAction: 'Lakukan autentikasi ulang (reconnect) akun Google Calendar di Pengaturan.',
    };
  }

  // HTTP 403: Prioritize error.errors[].reason over wide string search
  if (status === 403) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // not JSON
    }

    const reasons: string[] = [];
    if (Array.isArray(parsed?.error?.errors)) {
      for (const errItem of parsed.error.errors) {
        if (typeof errItem?.reason === 'string') {
          reasons.push(errItem.reason);
        }
      }
    }

    // 1. Check reasons array first if present
    if (reasons.length > 0) {
      const isRateOrQuota = reasons.some((r) =>
        /^(rateLimitExceeded|userRateLimitExceeded|quotaExceeded|calendarUsageLimitsExceeded|dailyLimitExceeded|limitExceeded)$/i.test(r)
      );

      if (isRateOrQuota) {
        return {
          code: 'RATE_LIMIT_EXCEEDED',
          status: 403,
          isAuthError: false,
          isPermissionError: false,
          isRateLimitError: true,
          isTransient: true,
          shouldReauth: false,
          message: 'Batas kuota atau laju panggilan Google Calendar terlampaui (HTTP 403). Mohon tunggu beberapa saat sebelum mencoba kembali.',
          userAction: 'Tunggu beberapa menit sebelum mencoba kembali operasi kalender.',
        };
      }

      const isAccessNotConfigured = reasons.some((r) =>
        /^(accessNotConfigured)$/i.test(r)
      );

      if (isAccessNotConfigured) {
        return {
          code: 'API_NOT_CONFIGURED',
          status: 403,
          isAuthError: false,
          isPermissionError: false,
          isRateLimitError: false,
          isTransient: false,
          shouldReauth: false,
          message: 'Google Calendar API belum diaktifkan atau belum dikonfigurasi pada proyek Google Cloud pengembang.',
          userAction: 'Hubungi administrator atau pastikan Google Calendar API telah diaktifkan di Google Cloud Console.',
        };
      }

      const isPermission = reasons.some((r) =>
        /^(insufficientPermissions|forbidden)$/i.test(r)
      );

      if (isPermission) {
        return {
          code: 'PERMISSION_DENIED',
          status: 403,
          isAuthError: false,
          isPermissionError: true,
          isRateLimitError: false,
          isTransient: false,
          shouldReauth: false,
          message: 'Akses Google Calendar ditolak (HTTP 403). Pastikan izin cakupan (OAuth scope) kalender telah disetujui pada akun Google Anda.',
          userAction: 'Periksa izin akses aplikasi pada Akun Google Anda dan berikan izin kalender.',
        };
      }

      // Explicit reason present, but not recognized: UNKNOWN_ERROR with neutral message
      return {
        code: 'UNKNOWN_ERROR',
        status: 403,
        isAuthError: false,
        isPermissionError: false,
        isRateLimitError: false,
        isTransient: false,
        shouldReauth: false,
        message: 'Akses Google Calendar dibatasi atau ditolak oleh server Google (HTTP 403). Silakan periksa status layanan Google atau coba beberapa saat lagi.',
        userAction: 'Periksa status layanan Google Calendar atau coba kembali nanti.',
      };
    }

    // 2. Fallback when reasons array is empty: strictly check error.message without loose substring matching
    const parsedMsg = String(parsed?.error?.message || '');
    if (/rate limit exceeded|quota exceeded|user rate limit/i.test(parsedMsg)) {
      return {
        code: 'RATE_LIMIT_EXCEEDED',
        status: 403,
        isAuthError: false,
        isPermissionError: false,
        isRateLimitError: true,
        isTransient: true,
        shouldReauth: false,
        message: 'Batas kuota atau laju panggilan Google Calendar terlampaui (HTTP 403). Mohon tunggu beberapa saat sebelum mencoba kembali.',
        userAction: 'Tunggu beberapa menit sebelum mencoba kembali operasi kalender.',
      };
    }

    if (/access not configured|has not been used in project|is not enabled/i.test(parsedMsg)) {
      return {
        code: 'API_NOT_CONFIGURED',
        status: 403,
        isAuthError: false,
        isPermissionError: false,
        isRateLimitError: false,
        isTransient: false,
        shouldReauth: false,
        message: 'Google Calendar API belum diaktifkan atau belum dikonfigurasi pada proyek Google Cloud pengembang.',
        userAction: 'Hubungi administrator atau pastikan Google Calendar API telah diaktifkan di Google Cloud Console.',
      };
    }

    if (/insufficient permissions/i.test(parsedMsg)) {
      return {
        code: 'PERMISSION_DENIED',
        status: 403,
        isAuthError: false,
        isPermissionError: true,
        isRateLimitError: false,
        isTransient: false,
        shouldReauth: false,
        message: 'Akses Google Calendar ditolak (HTTP 403). Pastikan izin cakupan (OAuth scope) kalender telah disetujui pada akun Google Anda.',
        userAction: 'Periksa izin akses aplikasi pada Akun Google Anda dan berikan izin kalender.',
      };
    }

    // Default neutral message for unknown 403 without accusing OAuth scope
    return {
      code: 'UNKNOWN_ERROR',
      status: 403,
      isAuthError: false,
      isPermissionError: false,
      isRateLimitError: false,
      isTransient: false,
      shouldReauth: false,
      message: 'Akses Google Calendar dibatasi atau ditolak oleh server Google (HTTP 403). Silakan periksa status layanan Google atau coba beberapa saat lagi.',
      userAction: 'Periksa status layanan Google Calendar atau coba kembali nanti.',
    };
  }

  // HTTP 404: Not Found
  if (status === 404) {
    return {
      code: 'NOT_FOUND',
      status: 404,
      isAuthError: false,
      isPermissionError: false,
      isRateLimitError: false,
      isTransient: false,
      shouldReauth: false,
      message: 'Sumber daya atau kalender Google tidak ditemukan (HTTP 404). Data lokal Anda tetap aman.',
      userAction: 'Pastikan kalender utama (primary) aktif pada akun Google Anda.',
    };
  }

  // HTTP 429: Rate Limit Exceeded
  if (status === 429) {
    return {
      code: 'RATE_LIMIT_EXCEEDED',
      status: 429,
      isAuthError: false,
      isPermissionError: false,
      isRateLimitError: true,
      isTransient: true,
      shouldReauth: false,
      message: 'Batas kuota panggilan Google Calendar API terlampaui (HTTP 429). Data lokal Anda tetap aman.',
      userAction: 'Tunggu beberapa saat sebelum mencoba sinkronisasi atau pembuatan jadwal berikutnya.',
    };
  }

  // HTTP 500-599: Google Service Error
  if (status >= 500 && status <= 599) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      status,
      isAuthError: false,
      isPermissionError: false,
      isRateLimitError: false,
      isTransient: true,
      shouldReauth: false,
      message: `Layanan Google Calendar sedang mengalami gangguan sementara (HTTP ${status}). Data lokal tetap tersimpan.`,
      userAction: 'Layanan Google mungkin sedang dalam perbaikan. Coba kembali beberapa saat lagi.',
    };
  }

  // Check Invalid Response / Empty ID
  if (rawBody.includes('tidak dapat dikonfirmasi') || rawBody.includes('ID event kosong')) {
    return {
      code: 'INVALID_RESPONSE',
      status,
      isAuthError: false,
      isPermissionError: false,
      isRateLimitError: false,
      isTransient: true,
      shouldReauth: false,
      message: 'Hasil pembuatan agenda di Google Calendar tidak dapat dikonfirmasi (ID event kosong dari server Google).',
      userAction: 'Periksa jadwal di Google Calendar untuk memastikan agenda telah dibuat.',
    };
  }

  // Fallback Unknown Error
  const sanitized = sanitizeGoogleErrorMessage(status, rawBody);
  return {
    code: 'UNKNOWN_ERROR',
    status,
    isAuthError: false,
    isPermissionError: false,
    isRateLimitError: false,
    isTransient: false,
    shouldReauth: false,
    message: `Gagal berkomunikasi dengan Google Calendar (${status}): ${sanitized}`,
    userAction: 'Periksa konsol peramban atau hubungi dukungan jika masalah berlanjut.',
  };
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
  timeMax?: Date,
  signal?: AbortSignal
): Promise<{ events: CalendarEvent[]; rangeStart: string; rangeEnd: string }> {
  if (!accessToken || !accessToken.trim()) {
    const classification = classifyGoogleCalendarError(401, 'Token Google Calendar tidak tersedia atau kedaluwarsa');
    throw new GoogleCalendarApiError(classification);
  }

  const minDate = timeMin || new Date(Date.now() - 7 * 86400000);
  const maxDate = timeMax || new Date(Date.now() + 30 * 86400000);
  const minIso = minDate.toISOString();
  const maxIso = maxDate.toISOString();

  if (signal?.aborted) {
    const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError', message: 'Permintaan ke Google Calendar dibatalkan oleh pengguna.' });
    throw new GoogleCalendarApiError(classification);
  }

  let pageToken: string | undefined = undefined;
  const allEvents: CalendarEvent[] = [];
  let pageCount = 0;
  const MAX_PAGES = 10;

  do {
    if (signal?.aborted) {
      const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError', message: 'Permintaan ke Google Calendar dibatalkan oleh pengguna.' });
      throw new GoogleCalendarApiError(classification);
    }
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
        signal,
      });
    } catch (netErr: any) {
      const classification = classifyGoogleCalendarError(0, '', netErr);
      throw new GoogleCalendarApiError(classification);
    }

    if (!res.ok) {
      let errText = '';
      try {
        errText = await res.text();
      } catch (readErr: any) {
        if (signal?.aborted || readErr?.name === 'AbortError' || String(readErr?.message).toLowerCase().includes('abort')) {
          const classification = classifyGoogleCalendarError(0, '', readErr || { name: 'AbortError' });
          throw new GoogleCalendarApiError(classification);
        }
      }
      if (signal?.aborted) {
        const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError' });
        throw new GoogleCalendarApiError(classification);
      }
      const classification = classifyGoogleCalendarError(res.status, errText);
      console.error(`Google Calendar Fetch Error [${res.status}]:`, classification.message);
      throw new GoogleCalendarApiError(classification);
    }

    let data: any;
    try {
      data = await res.json();
    } catch (parseErr: any) {
      if (signal?.aborted || parseErr?.name === 'AbortError' || String(parseErr?.message).toLowerCase().includes('abort')) {
        const classification = classifyGoogleCalendarError(0, '', parseErr || { name: 'AbortError' });
        throw new GoogleCalendarApiError(classification);
      }
      const classification = classifyGoogleCalendarError(200, 'Format JSON tidak valid');
      throw new GoogleCalendarApiError({
        ...classification,
        code: 'INVALID_RESPONSE',
        message: 'Respons dari Google Calendar tidak dapat diverifikasi (format JSON tidak valid).',
      });
    }

    if (signal?.aborted) {
      const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError' });
      throw new GoogleCalendarApiError(classification);
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

  // Pagination Integrity: Cegah silent partial events yang dapat menimpa kalender lokal
  if (pageToken) {
    const classification = classifyGoogleCalendarError(0, 'Pagination limit exceeded - sisa halaman belum terambil');
    throw new GoogleCalendarApiError({
      ...classification,
      code: 'PAGINATION_LIMIT_EXCEEDED',
      status: 0,
      isTransient: true,
      shouldReauth: false,
      message: `Pengambilan agenda Google Calendar melebihi batas ${MAX_PAGES} halaman dan belum selesai. Sinkronisasi dihentikan agar tidak menggantikan kalender lokal dengan data parsial.`,
      userAction: 'Persempit rentang tanggal pencarian atau kurangi jumlah agenda pada akun kalender Anda.',
    });
  }

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
  },
  signal?: AbortSignal
): Promise<{ id: string; htmlLink?: string }> {
  if (!accessToken || !accessToken.trim()) {
    const classification = classifyGoogleCalendarError(401, 'Token Google Calendar tidak tersedia (HTTP 401).');
    throw new GoogleCalendarApiError(classification);
  }

  if (signal?.aborted) {
    const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError', message: 'Permintaan ke Google Calendar dibatalkan oleh pengguna.' });
    throw new GoogleCalendarApiError(classification);
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
      signal,
    });
  } catch (netErr: any) {
    const classification = classifyGoogleCalendarError(0, '', netErr);
    if (classification.code === 'ABORTED') {
      throw new GoogleCalendarApiError(classification);
    }
    throw new GoogleCalendarApiError({
      ...classification,
      message: `Koneksi jaringan gagal saat mengirim agenda ke Google Calendar: ${sanitizeSensitiveText(netErr.message || 'Server tidak dapat dijangkau')}`,
    });
  }

  if (!res.ok) {
    let errText = '';
    try {
      errText = await res.text();
    } catch (readErr: any) {
      if (signal?.aborted || readErr?.name === 'AbortError' || String(readErr?.message).toLowerCase().includes('abort')) {
        const classification = classifyGoogleCalendarError(0, '', readErr || { name: 'AbortError' });
        throw new GoogleCalendarApiError(classification);
      }
    }
    if (signal?.aborted) {
      const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError' });
      throw new GoogleCalendarApiError(classification);
    }
    const classification = classifyGoogleCalendarError(res.status, errText);
    console.error(`Google Calendar Event Write Error [${res.status}]:`, classification.message);
    throw new GoogleCalendarApiError(classification);
  }

  let created: any;
  try {
    created = await res.json();
  } catch (parseErr: any) {
    if (signal?.aborted || parseErr?.name === 'AbortError' || String(parseErr?.message).toLowerCase().includes('abort')) {
      const classification = classifyGoogleCalendarError(0, '', parseErr || { name: 'AbortError' });
      throw new GoogleCalendarApiError(classification);
    }
    const classification = classifyGoogleCalendarError(200, 'Format JSON tidak valid');
    throw new GoogleCalendarApiError({
      ...classification,
      code: 'INVALID_RESPONSE',
      message: 'Respons sukses diterima dari Google Calendar tetapi format JSON tidak valid.',
    });
  }

  if (signal?.aborted) {
    const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError' });
    throw new GoogleCalendarApiError(classification);
  }

  // CRITICAL VALIDATION: Check for valid, non-empty event ID
  if (!created || typeof created.id !== 'string' || !created.id.trim()) {
    const classification = classifyGoogleCalendarError(200, 'tidak dapat dikonfirmasi - ID event kosong');
    throw new GoogleCalendarApiError(classification);
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
  googleEventId: string,
  signal?: AbortSignal
): Promise<void> {
  if (!accessToken || !accessToken.trim()) {
    const classification = classifyGoogleCalendarError(401, 'Token Google Calendar tidak tersedia.');
    throw new GoogleCalendarApiError(classification);
  }

  if (signal?.aborted) {
    const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError', message: 'Permintaan ke Google Calendar dibatalkan oleh pengguna.' });
    throw new GoogleCalendarApiError(classification);
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
      signal,
    });
  } catch (netErr: any) {
    const classification = classifyGoogleCalendarError(0, '', netErr);
    if (classification.code === 'ABORTED') {
      throw new GoogleCalendarApiError(classification);
    }
    throw new GoogleCalendarApiError({
      ...classification,
      message: `Koneksi jaringan terputus saat menghapus agenda: ${sanitizeSensitiveText(netErr.message || '')}`,
    });
  }

  // 404 is considered successfully deleted (already gone)
  if (!res.ok && res.status !== 404) {
    let errText = '';
    try {
      errText = await res.text();
    } catch (readErr: any) {
      if (signal?.aborted || readErr?.name === 'AbortError' || String(readErr?.message).toLowerCase().includes('abort')) {
        const classification = classifyGoogleCalendarError(0, '', readErr || { name: 'AbortError' });
        throw new GoogleCalendarApiError(classification);
      }
    }
    if (signal?.aborted) {
      const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError' });
      throw new GoogleCalendarApiError(classification);
    }
    const classification = classifyGoogleCalendarError(res.status, errText);
    console.error(`Google Calendar Event Delete Error [${res.status}]:`, classification.message);
    throw new GoogleCalendarApiError(classification);
  }
}

/**
 * Updates an existing event on Google Calendar
 */
export async function updateGoogleCalendarEvent(
  accessToken: string,
  googleEventId: string,
  event: {
    title?: string;
    description?: string;
    startAt?: string;
    endAt?: string;
    isAllDay?: boolean;
    timezone?: string;
  },
  signal?: AbortSignal
): Promise<{ id: string; htmlLink?: string }> {
  if (!accessToken || !accessToken.trim()) {
    const classification = classifyGoogleCalendarError(401, 'Token Google Calendar tidak tersedia (HTTP 401).');
    throw new GoogleCalendarApiError(classification);
  }

  if (signal?.aborted) {
    const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError', message: 'Permintaan ke Google Calendar dibatalkan oleh pengguna.' });
    throw new GoogleCalendarApiError(classification);
  }

  const cleanId = googleEventId.replace(/^gcal-/, '');
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${cleanId}`;

  const tz = event.timezone || 'Asia/Jakarta';
  const payload: Record<string, any> = {};

  if (event.title !== undefined) {
    payload.summary = event.title;
  }
  if (event.description !== undefined) {
    payload.description = event.description;
  }

  if (event.startAt && event.endAt) {
    const sTime = new Date(event.startAt).getTime();
    const eTime = new Date(event.endAt).getTime();
    if (isNaN(sTime) || isNaN(eTime) || eTime <= sTime) {
      throw new Error('Waktu mulai harus lebih awal dari waktu selesai.');
    }

    if (event.isAllDay) {
      const startDateOnly = event.startAt.split('T')[0];
      const endDateOnly = event.endAt.split('T')[0];
      payload.start = { date: startDateOnly };
      payload.end = { date: endDateOnly };
    } else {
      payload.start = { dateTime: event.startAt, timeZone: tz };
      payload.end = { dateTime: event.endAt, timeZone: tz };
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (netErr: any) {
    const classification = classifyGoogleCalendarError(0, '', netErr);
    if (classification.code === 'ABORTED') {
      throw new GoogleCalendarApiError(classification);
    }
    throw new GoogleCalendarApiError({
      ...classification,
      message: `Koneksi jaringan gagal saat memperbarui agenda di Google Calendar: ${sanitizeSensitiveText(netErr.message || 'Server tidak dapat dijangkau')}`,
    });
  }

  if (!res.ok) {
    let errText = '';
    try {
      errText = await res.text();
    } catch (readErr: any) {
      if (signal?.aborted || readErr?.name === 'AbortError' || String(readErr?.message).toLowerCase().includes('abort')) {
        const classification = classifyGoogleCalendarError(0, '', readErr || { name: 'AbortError' });
        throw new GoogleCalendarApiError(classification);
      }
    }
    if (signal?.aborted) {
      const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError' });
      throw new GoogleCalendarApiError(classification);
    }
    const classification = classifyGoogleCalendarError(res.status, errText);
    console.error(`Google Calendar Event Update Error [${res.status}]:`, classification.message);
    throw new GoogleCalendarApiError(classification);
  }

  let updated: any;
  try {
    updated = await res.json();
  } catch (parseErr: any) {
    if (signal?.aborted || parseErr?.name === 'AbortError' || String(parseErr?.message).toLowerCase().includes('abort')) {
      const classification = classifyGoogleCalendarError(0, '', parseErr || { name: 'AbortError' });
      throw new GoogleCalendarApiError(classification);
    }
    const classification = classifyGoogleCalendarError(200, 'Format JSON tidak valid');
    throw new GoogleCalendarApiError({
      ...classification,
      code: 'INVALID_RESPONSE',
      message: 'Respons sukses diterima dari Google Calendar tetapi format JSON tidak valid.',
    });
  }

  if (signal?.aborted) {
    const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError' });
    throw new GoogleCalendarApiError(classification);
  }

  if (!updated || typeof updated.id !== 'string' || !updated.id.trim()) {
    const classification = classifyGoogleCalendarError(200, 'tidak dapat dikonfirmasi - ID event kosong');
    throw new GoogleCalendarApiError(classification);
  }

  return {
    id: updated.id.trim(),
    htmlLink: updated.htmlLink,
  };
}

export interface BatchCreateEventItem {
  id: string; // local session or task id
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  timezone?: string;
  isAllDay?: boolean;
  googleCalendarEventId?: string;
  syncStatus?: string;
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
    classification?: GoogleCalendarErrorClassification;
  }>;
}

/**
 * Mengunggah agenda masa depan ke Google Calendar secara efisien dalam chunk batch
 * untuk menghemat kuota API Google Calendar dan meminimalkan latensi jaringan.
 */
export async function batchCreateGoogleCalendarEvents(
  accessToken: string,
  events: BatchCreateEventItem[],
  chunkSize: number = 5,
  signal?: AbortSignal
): Promise<BatchCreateResult> {
  if (!accessToken || !accessToken.trim()) {
    const classification = classifyGoogleCalendarError(401, 'Token Google Calendar tidak tersedia (HTTP 401).');
    throw new GoogleCalendarApiError(classification);
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
    classification?: GoogleCalendarErrorClassification;
  }> = [];

  for (let i = 0; i < events.length; i += chunkSize) {
    if (signal?.aborted) {
      break;
    }

    const chunk = events.slice(i, i + chunkSize);
    const chunkPromises = chunk.map(async (ev) => {
      if (signal?.aborted) {
        return {
          localId: ev.id,
          error: 'Operasi dibatalkan oleh pengguna.',
          classification: classifyGoogleCalendarError(0, '', { name: 'AbortError' }),
        };
      }
      if (ev.googleCalendarEventId || ev.syncStatus === 'synced') {
        // Event already created in Google Calendar; prevent duplicate creation on retry
        return {
          localId: ev.id,
          googleCalendarEventId: ev.googleCalendarEventId,
        };
      }
      try {
        const created = await createGoogleCalendarEvent(
          accessToken,
          {
            title: ev.title,
            description: ev.description,
            startAt: ev.startAt,
            endAt: ev.endAt,
            timezone: ev.timezone,
            isAllDay: ev.isAllDay,
          },
          signal
        );
        return {
          localId: ev.id,
          googleCalendarEventId: created.id,
          htmlLink: created.htmlLink,
        };
      } catch (err: any) {
        const classification =
          err instanceof GoogleCalendarApiError
            ? err.classification
            : classifyGoogleCalendarError(0, err.message || '', err);

        return {
          localId: ev.id,
          error: err.message || 'Gagal menyimpan agenda ke Google Calendar.',
          classification,
        };
      }
    });

    const chunkResults = await Promise.all(chunkPromises);
    results.push(...chunkResults);

    if (signal?.aborted) {
      break;
    }

    if (i + chunkSize < events.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // If aborted before all events were processed, record remaining events as ABORTED so unpushed sessions are tracked
  if (results.length < events.length) {
    const unhandled = events.slice(results.length);
    for (const ev of unhandled) {
      results.push({
        localId: ev.id,
        error: 'Operasi dibatalkan oleh pengguna.',
        classification: classifyGoogleCalendarError(0, '', { name: 'AbortError' }),
      });
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
