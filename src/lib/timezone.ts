/**
 * Timezone utilities for EVEN AI Planner
 * Handles IANA timezones (e.g. Asia/Jakarta), local time conversion to UTC,
 * and eliminates dependency on the host machine's timezone.
 */

/**
 * Normalizes timezone strings like "Asia/Jakarta (WIB)" to pure IANA identifiers "Asia/Jakarta".
 */
export function normalizeTimezone(tz?: string | null): string {
  if (!tz || !tz.trim()) {
    return 'Asia/Jakarta';
  }
  const clean = tz.trim().split(' ')[0].trim();
  try {
    // Validate if Intl supports this timezone
    Intl.DateTimeFormat(undefined, { timeZone: clean });
    return clean;
  } catch {
    return 'Asia/Jakarta';
  }
}

/**
 * Returns date and time components of a given Date in the specified timezone.
 */
export function getZonedDateTimeParts(date: Date, timeZone: string = 'Asia/Jakarta') {
  const cleanTz = normalizeTimezone(timeZone);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: cleanTz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }

  const rawHour = parseInt(map.hour || '0', 10);
  const normalizedHour = rawHour === 24 ? 0 : rawHour;

  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10), // 1 - 12
    day: parseInt(map.day, 10),
    hour: normalizedHour,
    minute: parseInt(map.minute || '0', 10),
    second: parseInt(map.second || '0', 10),
    weekday: map.weekday,
  };
}

/**
 * Calculates the UTC offset in minutes for a specific Date in a given timezone.
 * E.g. for Asia/Jakarta (UTC+7) returns +420.
 */
export function getTimezoneOffsetMinutes(date: Date, timeZone: string = 'Asia/Jakarta'): number {
  const cleanTz = normalizeTimezone(timeZone);
  const parts = getZonedDateTimeParts(date, cleanTz);
  const targetUtcEstimate = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return Math.round((targetUtcEstimate - date.getTime()) / 60000);
}

/**
 * Creates an exact ISO string in UTC from year, month, day, hour, minute specified
 * in the user's target timezone, completely independent of the server machine's timezone.
 */
export function createIsoFromLocalZoned(
  year: number,
  month: number, // 1 - 12
  day: number,
  hour: number,
  minute: number = 0,
  second: number = 0,
  timeZone: string = 'Asia/Jakarta'
): string {
  const cleanTz = normalizeTimezone(timeZone);
  // Estimate UTC epoch using raw values
  const approxUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Get offset at this approximate time
  const offsetMinutes = getTimezoneOffsetMinutes(new Date(approxUtc), cleanTz);
  // Subtract offset to get true UTC timestamp
  const exactUtcMs = approxUtc - offsetMinutes * 60000;
  return new Date(exactUtcMs).toISOString();
}

/**
 * Returns formatted Indonesian date/time string in the specified timezone.
 */
export function formatInUserTimezone(
  date: Date | string,
  timeZone: string = 'Asia/Jakarta',
  options?: Intl.DateTimeFormatOptions
): string {
  const cleanTz = normalizeTimezone(timeZone);
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';

  return d.toLocaleString('id-ID', {
    timeZone: cleanTz,
    ...options,
  });
}
