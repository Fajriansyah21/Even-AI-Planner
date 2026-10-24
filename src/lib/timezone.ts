/**
 * Comprehensive Timezone and Date Utility for EVEN AI Planner
 * Guarantees consistent calculations across server and client environments,
 * prioritizing Asia/Jakarta (WIB) and other Indonesian timezones (WITA, WIT).
 */

export function parseTimezoneString(tz?: string): string {
  if (!tz) return 'Asia/Jakarta';
  if (tz.includes('Asia/Jakarta') || tz.includes('WIB')) return 'Asia/Jakarta';
  if (tz.includes('Asia/Makassar') || tz.includes('WITA')) return 'Asia/Makassar';
  if (tz.includes('Asia/Jayapura') || tz.includes('WIT')) return 'Asia/Jayapura';
  if (tz.includes('UTC')) return 'UTC';
  return tz.split(' ')[0] || 'Asia/Jakarta';
}

export function getTimezoneOffsetMinutes(timeZone: string = 'Asia/Jakarta', date: Date = new Date()): number {
  const cleanTz = parseTimezoneString(timeZone);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: cleanTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const getPart = (type: string) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    let hour = getPart('hour');
    if (hour === 24) hour = 0;
    const minute = getPart('minute');
    const second = getPart('second');

    const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    // Default fallback: Asia/Jakarta UTC+7 = +420 min
    if (cleanTz === 'Asia/Makassar') return 480;
    if (cleanTz === 'Asia/Jayapura') return 540;
    if (cleanTz === 'UTC') return 0;
    return 420;
  }
}

export function getPartsInTimezone(
  date: Date,
  timeZone: string = 'Asia/Jakarta'
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
} {
  const cleanTz = parseTimezoneString(timeZone);
  const formatter = new Intl.DateTimeFormat('en-US', {
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
  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '0';
  let hour = parseInt(getPart('hour'), 10);
  if (hour === 24) hour = 0;

  const weekdayStr = (getPart('weekday') || '').toLowerCase();
  const daysMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const dayOfWeek = daysMap[weekdayStr] ?? date.getDay();

  return {
    year: parseInt(getPart('year'), 10),
    month: parseInt(getPart('month'), 10),
    day: parseInt(getPart('day'), 10),
    hour,
    minute: parseInt(getPart('minute'), 10),
    second: parseInt(getPart('second'), 10),
    dayOfWeek,
  };
}

export function createIsoInTimezone(
  year: number,
  month: number, // 1-indexed (1 = Jan, 12 = Dec)
  day: number,
  hour: number,
  minute: number = 0,
  second: number = 0,
  timeZone: string = 'Asia/Jakarta'
): string {
  const cleanTz = parseTimezoneString(timeZone);
  // Estimate UTC time
  const roughUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimezoneOffsetMinutes(cleanTz, roughUtc);
  const exactUtcMs = roughUtc.getTime() - offsetMinutes * 60 * 1000;
  return new Date(exactUtcMs).toISOString();
}

export function formatInTimezone(
  date: Date,
  timeZone: string = 'Asia/Jakarta',
  options?: Intl.DateTimeFormatOptions
): string {
  const cleanTz = parseTimezoneString(timeZone);
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: cleanTz,
    ...options,
  }).format(date);
}

export const normalizeTimezone = parseTimezoneString;
export const getZonedDateTimeParts = getPartsInTimezone;
export const formatInUserTimezone = formatInTimezone;

export function createIsoFromLocalZoned(
  dateStr: string, // YYYY-MM-DD
  timeStr: string, // HH:mm
  timeZone: string = 'Asia/Jakarta'
): string {
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const [hourStr, minStr] = timeStr.split(':');
  return createIsoInTimezone(
    parseInt(yearStr, 10),
    parseInt(monthStr, 10),
    parseInt(dayStr, 10),
    parseInt(hourStr, 10),
    parseInt(minStr || '0', 10),
    0,
    timeZone
  );
}

