import { strict as assert } from 'assert';
import {
  normalizeTimezone,
  getZonedDateTimeParts,
  getTimezoneOffsetMinutes,
  createIsoFromLocalZoned,
  formatInUserTimezone,
} from '../src/lib/timezone';
import { parseIndonesianTemporalRules } from '../src/lib/temporalParser';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';
import { Task, CalendarEvent, UserPreferences } from '../src/types';

console.log('--- RUNNING TIMEZONE & TEMPORAL CONVERSION TESTS (Asia/Jakarta) ---');

// =========================================================================
// TEST SUITE 1: Direct Intl.DateTimeFormat & 19:00–22:00 WIB Scenario
// Verifies ISO 8601 conversion accurately reflects local time without day shifts
// =========================================================================
console.log('\n[Suite 1] Intl.DateTimeFormat Validation: 19:00–22:00 in Asia/Jakarta');

{
  const timeZone = 'Asia/Jakarta'; // UTC+7
  const year = 2026;
  const month = 10;
  const day = 22;

  // 1. Direct verification using Intl.DateTimeFormat with Asia/Jakarta
  const dtfJakarta = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // Target local hours: 19:00 and 22:00
  // Since Asia/Jakarta is UTC+7 (no DST), 19:00 WIB corresponds strictly to 12:00:00.000Z
  // and 22:00 WIB corresponds strictly to 15:00:00.000Z.
  const isoStart = createIsoFromLocalZoned(year, month, day, 19, 0, 0, timeZone);
  const isoEnd = createIsoFromLocalZoned(year, month, day, 22, 0, 0, timeZone);

  assert.equal(
    isoStart,
    '2026-10-22T12:00:00.000Z',
    '19:00 WIB must convert to exact UTC ISO 8601: 2026-10-22T12:00:00.000Z'
  );

  assert.equal(
    isoEnd,
    '2026-10-22T15:00:00.000Z',
    '22:00 WIB must convert to exact UTC ISO 8601: 2026-10-22T15:00:00.000Z'
  );

  // 2. Validate using Intl.DateTimeFormat formatToParts to ensure no day shift occurs
  const startDate = new Date(isoStart);
  const endDate = new Date(isoEnd);

  const startParts = dtfJakarta.formatToParts(startDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {} as Record<string, string>);

  const endParts = dtfJakarta.formatToParts(endDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {} as Record<string, string>);

  // Check Year, Month, Day in Asia/Jakarta
  assert.equal(startParts.year, '2026', 'Start year in Asia/Jakarta must be 2026');
  assert.equal(startParts.month, '10', 'Start month in Asia/Jakarta must be 10 (October)');
  assert.equal(startParts.day, '22', 'Start day in Asia/Jakarta must NOT shift; must remain 22');
  assert.equal(startParts.hour, '19', 'Start hour in Asia/Jakarta must be 19 (7 PM)');
  assert.equal(startParts.minute, '00', 'Start minute must be 00');

  assert.equal(endParts.year, '2026', 'End year in Asia/Jakarta must be 2026');
  assert.equal(endParts.month, '10', 'End month in Asia/Jakarta must be 10 (October)');
  assert.equal(endParts.day, '22', 'End day in Asia/Jakarta must NOT shift; must remain 22');
  assert.equal(endParts.hour, '22', 'End hour in Asia/Jakarta must be 22 (10 PM)');
  assert.equal(endParts.minute, '00', 'End minute must be 00');

  // Verify that duration between start and end is exactly 3 hours (180 minutes)
  const diffMinutes = (endDate.getTime() - startDate.getTime()) / 60000;
  assert.equal(diffMinutes, 180, 'Duration between 19:00 and 22:00 must be exactly 180 minutes');

  console.log('✓ Intl.DateTimeFormat accurately reflects 19:00 and 22:00 on 2026-10-22 without day shift');
}

// =========================================================================
// TEST SUITE 2: Indonesian Natural Language Parsing for 19:00–22:00 Case
// =========================================================================
console.log('\n[Suite 2] Indonesian Natural Language Parsing (19:00–22:00)');

{
  // Parsing prompt: "Kamis 22 Okt 19:00-22:00 WIB"
  const parsed = parseIndonesianTemporalRules({
    userPrompt: 'Kelas Web Development Kamis 22 Okt 19:00-22:00 WIB',
    currentDateTime: '2026-10-22T03:00:00.000Z', // 10:00 AM WIB on Oct 22
    userTimezone: 'Asia/Jakarta',
  });

  assert.equal(parsed.timeConstraintType, 'fixed_event');
  assert.equal(parsed.requestedStartAt, '2026-10-22T12:00:00.000Z');
  assert.equal(parsed.requestedEndAt, '2026-10-22T15:00:00.000Z');
  assert.equal(parsed.estimatedDurationMinutes, 180);
  assert.equal(parsed.preferredTimeOfDay, 'EVENING');

  // Validate the parsed ISO dates through Intl.DateTimeFormat
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'numeric',
    hour: 'numeric',
    hour12: false,
  });
  const startParts = dtf.formatToParts(new Date(parsed.requestedStartAt!));
  const dayPart = startParts.find(p => p.type === 'day')?.value;
  const hourPart = startParts.find(p => p.type === 'hour')?.value;

  assert.equal(dayPart, '22', 'Parsed requestedStartAt day must be 22 in Asia/Jakarta');
  assert.equal(hourPart, '19', 'Parsed requestedStartAt hour must be 19 in Asia/Jakarta');

  console.log('✓ "Kamis 22 Okt 19:00-22:00 WIB" parses to 12:00Z - 15:00Z and retains day 22 in Asia/Jakarta');
}

{
  // Parsing informal prompt: "Malam ini jam 7 sampai 10 malam"
  const parsed = parseIndonesianTemporalRules({
    userPrompt: 'Belajar persiapan ujian malam ini jam 7 sampai 10 malam',
    currentDateTime: '2026-10-22T03:00:00.000Z', // 10:00 AM WIB on Oct 22
    userTimezone: 'Asia/Jakarta',
  });

  assert.equal(parsed.timeConstraintType, 'fixed_event');
  assert.equal(parsed.requestedStartAt, '2026-10-22T12:00:00.000Z');
  assert.equal(parsed.requestedEndAt, '2026-10-22T15:00:00.000Z');
  assert.equal(parsed.estimatedDurationMinutes, 180);

  console.log('✓ "Malam ini jam 7 sampai 10 malam" resolves accurately to 19:00–22:00 WIB');
}

// =========================================================================
// TEST SUITE 3: Cross-Midnight Scheduling & Multi-Day Date Handling
// =========================================================================
console.log('\n[Suite 3] Cross-Midnight Scheduling (23:00 to 01:30 WIB)');

{
  // Case: Session starting at 23:00 WIB on Oct 22 and ending at 01:30 WIB on Oct 23
  // 23:00 WIB = 16:00:00 UTC (Oct 22)
  // 01:30 WIB next day = 18:30:00 UTC (Oct 22)
  const startIso = createIsoFromLocalZoned(2026, 10, 22, 23, 0, 0, 'Asia/Jakarta');
  const endIso = createIsoFromLocalZoned(2026, 10, 23, 1, 30, 0, 'Asia/Jakarta');

  assert.equal(startIso, '2026-10-22T16:00:00.000Z');
  assert.equal(endIso, '2026-10-22T18:30:00.000Z');

  const durationMin = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000;
  assert.equal(durationMin, 150, 'Cross-midnight duration 23:00 -> 01:30 must be exactly 150 minutes');

  // Verify in local timezone components using Intl.DateTimeFormat
  const startParts = getZonedDateTimeParts(new Date(startIso), 'Asia/Jakarta');
  const endParts = getZonedDateTimeParts(new Date(endIso), 'Asia/Jakarta');

  assert.equal(startParts.day, 22);
  assert.equal(startParts.hour, 23);
  assert.equal(endParts.day, 23, 'End date must be the next calendar day in Asia/Jakarta');
  assert.equal(endParts.hour, 1);
  assert.equal(endParts.minute, 30);

  console.log('✓ Cross-midnight ISO conversion cleanly increments local day while keeping UTC monotonic');
}

{
  // Test temporal parser on cross-midnight colon range: "23:00 - 01:00"
  const parsed = parseIndonesianTemporalRules({
    userPrompt: 'Deployment server Kamis 22 Okt 23:00 - 01:00',
    currentDateTime: '2026-10-22T05:00:00.000Z',
    userTimezone: 'Asia/Jakarta',
  });

  assert.equal(parsed.timeConstraintType, 'fixed_event');
  assert.equal(parsed.requestedStartAt, '2026-10-22T16:00:00.000Z'); // 23:00 WIB
  assert.equal(parsed.requestedEndAt, '2026-10-22T18:00:00.000Z');   // 01:00 WIB next day
  assert.equal(parsed.estimatedDurationMinutes, 120);

  const endParts = getZonedDateTimeParts(new Date(parsed.requestedEndAt!), 'Asia/Jakarta');
  assert.equal(endParts.day, 23, 'End time for 23:00 - 01:00 must fall on the 23rd in Asia/Jakarta');
  assert.equal(endParts.hour, 1);

  console.log('✓ Temporal parser handles colon range crossing midnight ("23:00 - 01:00")');
}

{
  // Test temporal parser on cross-midnight word range: "jam 23.00 sampai 01.30"
  const parsed = parseIndonesianTemporalRules({
    userPrompt: 'Maintenance jaringan malam ini jam 23.00 sampai 01.30',
    currentDateTime: '2026-10-22T05:00:00.000Z',
    userTimezone: 'Asia/Jakarta',
  });

  assert.equal(parsed.timeConstraintType, 'fixed_event');
  assert.equal(parsed.requestedStartAt, '2026-10-22T16:00:00.000Z');
  assert.equal(parsed.requestedEndAt, '2026-10-22T18:30:00.000Z');
  assert.equal(parsed.estimatedDurationMinutes, 150);

  console.log('✓ Temporal parser handles word range crossing midnight ("jam 23.00 sampai 01.30")');
}

// =========================================================================
// TEST SUITE 4: Server Host Timezone Agnosticism & Intl.DateTimeFormat
// =========================================================================
console.log('\n[Suite 4] Agnosticism of Host Server Machine Timezone');

{
  // Test offset calculation across multiple local times using Intl
  const testEpochs = [
    new Date('2026-01-15T00:00:00.000Z'),
    new Date('2026-06-20T12:00:00.000Z'),
    new Date('2026-10-22T18:00:00.000Z'),
  ];

  for (const epoch of testEpochs) {
    const offset = getTimezoneOffsetMinutes(epoch, 'Asia/Jakarta');
    assert.equal(offset, 420, 'Asia/Jakarta offset must strictly remain +420 minutes (UTC+7)');
  }

  // Ensure normalizeTimezone cleans decorators like "Asia/Jakarta (WIB)"
  assert.equal(normalizeTimezone('Asia/Jakarta (WIB)'), 'Asia/Jakarta');
  assert.equal(normalizeTimezone('  Asia/Jakarta  '), 'Asia/Jakarta');
  assert.equal(normalizeTimezone(undefined), 'Asia/Jakarta');
  assert.equal(normalizeTimezone('Invalid/Timezone_Name_Test'), 'Asia/Jakarta');

  // Bidirectional consistency check:
  // For any hour 0..23, createIsoFromLocalZoned -> getZonedDateTimeParts (Intl-based) must match input exactly
  for (let hour = 0; hour < 24; hour++) {
    const minute = 15;
    const iso = createIsoFromLocalZoned(2026, 8, 14, hour, minute, 0, 'Asia/Jakarta');
    const parts = getZonedDateTimeParts(new Date(iso), 'Asia/Jakarta');
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 8);
    assert.equal(parts.day, 14);
    assert.equal(parts.hour, hour, `Hour mismatch at hour ${hour}`);
    assert.equal(parts.minute, minute, `Minute mismatch at hour ${hour}`);
  }

  console.log('✓ All 24 hours round-trip identically through createIsoFromLocalZoned and Intl.DateTimeFormat');
}

// =========================================================================
// TEST SUITE 5: Absolute Start/End Time Adherence in Scheduler
// =========================================================================
console.log('\n[Suite 5] Absolute Start/End Adherence in Deterministic Scheduler');

{
  const defaultPrefs: UserPreferences = {
    workDays: [1, 2, 3, 4, 5],
    workStartHour: 9,
    workEndHour: 17, // Standard work hours 09:00–17:00
    bufferMinutes: 10,
    preferredWorkTime: 'MORNING',
    timezone: 'Asia/Jakarta',
  };

  // User specifies 19:00–22:00 WIB (which is OUTSIDE normal work hours 09:00-17:00)
  const task19to22: Task = {
    id: 'task-evening-class',
    title: 'Kelas Malam Pemrograman',
    estimatedDurationMinutes: 180,
    timeConstraintType: 'fixed_event',
    requestedStartAt: '2026-10-22T12:00:00.000Z', // 19:00 WIB
    requestedEndAt: '2026-10-22T15:00:00.000Z',   // 22:00 WIB
    preferredTimeOfDay: 'EVENING',
    timezone: 'Asia/Jakarta',
    priority: 'HIGH',
    status: 'TODO',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const scheduleResult = scheduleTaskDeterministically(
    task19to22,
    [],
    [],
    defaultPrefs,
    new Date('2026-10-22T03:00:00.000Z')
  );

  assert.equal(scheduleResult.success, true, 'Scheduler must accept explicit evening fixed event');
  assert.equal(scheduleResult.proposedSessions.length, 1);
  assert.equal(
    scheduleResult.proposedSessions[0].startAt,
    '2026-10-22T12:00:00.000Z',
    'Scheduler MUST NOT shift explicit 19:00 start time into work hours (09:00)'
  );
  assert.equal(
    scheduleResult.proposedSessions[0].endAt,
    '2026-10-22T15:00:00.000Z',
    'Scheduler MUST NOT shift explicit 22:00 end time'
  );

  console.log('✓ Scheduler strictly adheres to explicit 19:00–22:00 without shifting into work hours');
}

{
  // Test scheduler collision detection on cross-midnight fixed event
  const defaultPrefs: UserPreferences = {
    workDays: [1, 2, 3, 4, 5],
    workStartHour: 9,
    workEndHour: 17,
    bufferMinutes: 10,
    timezone: 'Asia/Jakarta',
  };

  const midnightTask: Task = {
    id: 'task-midnight-deploy',
    title: 'Deployment Lintas Malam',
    estimatedDurationMinutes: 150,
    timeConstraintType: 'fixed_event',
    requestedStartAt: '2026-10-22T16:00:00.000Z', // 23:00 WIB (Oct 22)
    requestedEndAt: '2026-10-22T18:30:00.000Z',   // 01:30 WIB (Oct 23)
    preferredTimeOfDay: 'EVENING',
    timezone: 'Asia/Jakarta',
    priority: 'HIGH',
    status: 'TODO',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Case A: No collision
  const successResult = scheduleTaskDeterministically(
    midnightTask,
    [],
    [],
    defaultPrefs,
    new Date('2026-10-22T05:00:00.000Z')
  );
  assert.equal(successResult.success, true);
  assert.equal(successResult.proposedSessions[0].startAt, '2026-10-22T16:00:00.000Z');
  assert.equal(successResult.proposedSessions[0].endAt, '2026-10-22T18:30:00.000Z');
  assert.equal(successResult.proposedSessions[0].durationMinutes, 150);

  // Case B: Calendar collision straddling midnight (e.g. 23:30 to 00:30 WIB)
  const overlappingEvent: CalendarEvent = {
    id: 'event-server-restart',
    title: 'Server Maintenance Window',
    startAt: '2026-10-22T16:30:00.000Z', // 23:30 WIB
    endAt: '2026-10-22T17:30:00.000Z',   // 00:30 WIB
  };

  const collisionResult = scheduleTaskDeterministically(
    midnightTask,
    [overlappingEvent],
    [],
    defaultPrefs,
    new Date('2026-10-22T05:00:00.000Z')
  );

  assert.equal(collisionResult.success, false);
  assert.equal(collisionResult.failureCode, 'TIME_CONFLICT');
  assert.match(collisionResult.explanation, /Server Maintenance Window/);

  console.log('✓ Scheduler accurately places cross-midnight fixed events and catches overlapping conflicts');
}

// =========================================================================
// TEST SUITE 6: Formatting with Indonesian Locale & Timezone
// =========================================================================
console.log('\n[Suite 6] Indonesian Localized Formatting with Timezone');

{
  const testIso = '2026-10-22T12:00:00.000Z'; // 19:00 WIB
  const formatted = formatInUserTimezone(testIso, 'Asia/Jakarta', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  assert.equal(formatted, '19.00', 'Indonesian locale formats 19:00 as "19.00"');
  console.log('✓ formatInUserTimezone formats times correctly with Indonesian locale');
}

console.log('\n======================================================');
console.log('ALL TIMEZONE & TEMPORAL CONVERSION TESTS PASSED CLEANLY');
console.log('======================================================\n');
