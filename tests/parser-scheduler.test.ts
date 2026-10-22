import { parseIndonesianTemporalRules } from '../src/lib/temporalParser';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';
import { Task, CalendarEvent, UserPreferences } from '../src/types';
import {
  getZonedDateTimeParts,
  createIsoFromLocalZoned,
  normalizeTimezone,
} from '../src/lib/timezone';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

const defaultPreferences: UserPreferences = {
  displayName: 'Tester',
  email: 'tester@example.com',
  timezone: 'Asia/Jakarta (WIB)',
  workStartHour: 9,
  workEndHour: 18,
  lunchStartHour: 12,
  lunchEndHour: 13,
  bufferMinutes: 15,
  workDays: [1, 2, 3, 4, 5],
  googleCalendarConnected: false,
  calendarSyncStatus: 'pending',
  lastSyncedAt: null,
  allowAutoSplit: true,
};

async function runTests() {
  console.log('=== RUNNING EVEN PARSER & SCHEDULER TESTS ===\n');

  // Base reference date in Asia/Jakarta: 2026-10-19 08:00 WIB (Monday) = 2026-10-19T01:00:00.000Z
  const fixedBaseTime = '2026-10-19T01:00:00.000Z';
  const tz = 'Asia/Jakarta';

  // ----------------------------------------------------
  // TEST 1: Fixed Event Interpretation (19:00 - 22:00)
  // ----------------------------------------------------
  console.log('\n--- Test 1: "Malam ini ada kelas jam 7 malam sampai jam 10 malam" ---');
  const plan1 = parseIndonesianTemporalRules({
    userPrompt: 'Malam ini ada kelas jam 7 malam sampai jam 10 malam',
    currentDateTime: fixedBaseTime,
    userTimezone: tz,
  });

  assert(plan1.timeConstraintType === 'fixed_event', 'Constraint type must be fixed_event');
  assert(plan1.estimatedDurationMinutes === 180, 'Duration must be 180 minutes (3 hours)');
  assert(!plan1.allowSplit, 'Fixed event must never allow split');
  assert(Boolean(plan1.requestedStartAt && plan1.requestedEndAt), 'Must have start and end time');

  const startParts1 = getZonedDateTimeParts(new Date(plan1.requestedStartAt!), tz);
  const endParts1 = getZonedDateTimeParts(new Date(plan1.requestedEndAt!), tz);
  assert(startParts1.hour === 19, `Start hour in Asia/Jakarta must be 19 (7 PM), got ${startParts1.hour}`);
  assert(endParts1.hour === 22, `End hour in Asia/Jakarta must be 22 (10 PM), got ${endParts1.hour}`);

  // ----------------------------------------------------
  // TEST 2: Anti-regression 09.00 vs 21.00 (9 malam vs 9 pagi)
  // ----------------------------------------------------
  console.log('\n--- Test 2: "Malam ini jam 9 belajar materi React 45 menit" & "pukul 21.00" ---');
  const plan2 = parseIndonesianTemporalRules({
    userPrompt: 'Malam ini jam 9 belajar materi React 45 menit',
    currentDateTime: fixedBaseTime,
    userTimezone: tz,
  });

  assert(plan2.preferredTimeOfDay === 'EVENING', 'Must be classified as EVENING, never MORNING');
  if (plan2.requestedStartAt) {
    const sH = getZonedDateTimeParts(new Date(plan2.requestedStartAt), tz).hour;
    assert(sH === 21, `Requested start hour must be 21, not 9. Got ${sH}`);
  }

  const plan2b = parseIndonesianTemporalRules({
    userPrompt: 'Tugas evaluasi sistem pukul 21.00 durasi 60 menit',
    currentDateTime: fixedBaseTime,
    userTimezone: tz,
  });
  if (plan2b.requestedStartAt) {
    const sH2b = getZonedDateTimeParts(new Date(plan2b.requestedStartAt), tz).hour;
    assert(sH2b === 21, `Pukul 21.00 must parse to hour 21, got ${sH2b}`);
  }

  const planMorning = parseIndonesianTemporalRules({
    userPrompt: 'Diskusi jam 9 pagi durasi 60 menit',
    currentDateTime: fixedBaseTime,
    userTimezone: tz,
  });
  assert(planMorning.preferredTimeOfDay === 'MORNING', 'Pagi must parse as MORNING');
  if (planMorning.requestedStartAt) {
    const sHM = getZonedDateTimeParts(new Date(planMorning.requestedStartAt), tz).hour;
    assert(sHM === 9, `Jam 9 pagi must parse to hour 9, got ${sHM}`);
  }

  // ----------------------------------------------------
  // TEST 3: Date Rollover ("besok malam", "lusa")
  // ----------------------------------------------------
  console.log('\n--- Test 3: Date Rollover ("besok malam", "lusa") ---');
  const planBesok = parseIndonesianTemporalRules({
    userPrompt: 'Jadwalkan tugas 60 menit besok malam',
    currentDateTime: fixedBaseTime,
    userTimezone: tz,
  });
  assert(planBesok.preferredTimeOfDay === 'EVENING', 'Besok malam must have EVENING preference');
  assert(planBesok.deadlineDaysFromNow === 1, `Day offset for besok must be 1, got ${planBesok.deadlineDaysFromNow}`);

  const planLusa = parseIndonesianTemporalRules({
    userPrompt: 'Laporan keuangan lusa jam 14.00',
    currentDateTime: fixedBaseTime,
    userTimezone: tz,
  });
  assert(planLusa.deadlineDaysFromNow === 2, `Day offset for lusa must be 2, got ${planLusa.deadlineDaysFromNow}`);

  // ----------------------------------------------------
  // TEST 4: Scheduler Enforces Preferred Window (Evening Task)
  // ----------------------------------------------------
  console.log('\n--- Test 4: Scheduler handles "tugas 60 menit besok malam" without shifting to morning ---');
  const tomorrowEveningDeadline = createIsoFromLocalZoned(2026, 10, 20, 23, 59, 59, tz);

  const eveningTask: Task = {
    id: 'task-besok-malam',
    userId: 'user-default',
    title: 'Tugas 60 Menit Besok Malam',
    estimatedDurationMinutes: 60,
    deadlineAt: tomorrowEveningDeadline,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    preferredTimeOfDay: 'EVENING',
    timeConstraintType: 'preferred_window',
    preferredWindow: {
      startHour: 19,
      endHour: 22,
      label: 'Malam (19:00 - 22:00)',
    },
    timezone: tz,
    createdAt: fixedBaseTime,
  };

  const schedRes = scheduleTaskDeterministically(eveningTask, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(schedRes.success, 'Scheduler should find evening slot');
  assert(schedRes.proposedSessions.length === 1, 'Should have 1 session');

  const placedStart = new Date(schedRes.proposedSessions[0].startAt);
  const placedHour = getZonedDateTimeParts(placedStart, tz).hour;
  assert(placedHour >= 19 && placedHour <= 22, `Session must be placed in evening (19-22), but was placed at ${placedHour}:00!`);
  assert(placedHour !== 9, 'CRITICAL: Evening task must NEVER be scheduled at 09:00 morning!');

  // ----------------------------------------------------
  // TEST 5: Scheduler Rejects Shifts When Constraint Cannot Be Met
  // ----------------------------------------------------
  console.log('\n--- Test 5: Scheduler Rejects Shifts When Constraint Cannot Be Met ---');
  const blockingEventMonday: CalendarEvent = {
    id: 'blocker-mon',
    provider: 'google',
    title: 'Acara Keluarga Senin Malam',
    startAt: createIsoFromLocalZoned(2026, 10, 19, 19, 0, 0, tz),
    endAt: createIsoFromLocalZoned(2026, 10, 19, 23, 0, 0, tz),
    isEditable: false,
    syncStatus: 'synced',
  };
  const blockingEventTuesday: CalendarEvent = {
    id: 'blocker-tue',
    provider: 'google',
    title: 'Acara Keluarga Sepanjang Malam',
    startAt: createIsoFromLocalZoned(2026, 10, 20, 19, 0, 0, tz),
    endAt: createIsoFromLocalZoned(2026, 10, 20, 23, 0, 0, tz),
    isEditable: false,
    syncStatus: 'synced',
  };

  const strictEveningTask: Task = {
    ...eveningTask,
    deadlineAt: createIsoFromLocalZoned(2026, 10, 20, 22, 0, 0, tz),
  };

  const blockedRes = scheduleTaskDeterministically(
    strictEveningTask,
    [blockingEventMonday, blockingEventTuesday],
    [],
    defaultPreferences,
    new Date(fixedBaseTime)
  );
  assert(!blockedRes.success, 'Successfully reported inability to schedule without silent morning displacement');
  assert(blockedRes.failureCode === 'PREFERRED_WINDOW_FULL', `Failure code must be PREFERRED_WINDOW_FULL, got ${blockedRes.failureCode}`);
  assert(blockedRes.explanation.length > 0, 'Must provide clear Indonesian explanation');

  // ----------------------------------------------------
  // TEST 6: Fixed Event Cannot Be Moved & Reports TIME_CONFLICT
  // ----------------------------------------------------
  console.log('\n--- Test 6: Fixed event cannot be moved & reports TIME_CONFLICT ---');
  const classStart = createIsoFromLocalZoned(2026, 10, 20, 19, 0, 0, tz);
  const classEnd = createIsoFromLocalZoned(2026, 10, 20, 22, 0, 0, tz);

  const fixedClassTask: Task = {
    id: 'task-kelas-tetap',
    userId: 'user-default',
    title: 'Kelas Malam Tetap',
    estimatedDurationMinutes: 180,
    deadlineAt: classEnd,
    priority: 'URGENT',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'fixed_event',
    requestedStartAt: classStart,
    requestedEndAt: classEnd,
    createdAt: fixedBaseTime,
  };

  // Case A: Free evening -> placed exactly at requested start and end
  const freeRes = scheduleTaskDeterministically(fixedClassTask, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(freeRes.success, 'Fixed event should succeed when slot is free');
  const sess = freeRes.proposedSessions[0];
  assert(sess.startAt === classStart, 'Fixed event must start exactly at requested time');
  assert(sess.endAt === classEnd, 'Fixed event must end exactly at requested time');

  // Case B: Conflicting event overlaps -> must return TIME_CONFLICT and NOT shift
  const overlapMeeting: CalendarEvent = {
    id: 'meeting-overlap',
    provider: 'google',
    title: 'Rapat Koordinasi 20:00 - 21:00',
    startAt: createIsoFromLocalZoned(2026, 10, 20, 20, 0, 0, tz),
    endAt: createIsoFromLocalZoned(2026, 10, 20, 21, 0, 0, tz),
    isEditable: false,
    syncStatus: 'synced',
  };

  const conflictRes = scheduleTaskDeterministically(fixedClassTask, [overlapMeeting], [], defaultPreferences, new Date(fixedBaseTime));
  assert(!conflictRes.success, 'Fixed event with conflict must report failure');
  assert(conflictRes.failureCode === 'TIME_CONFLICT', `Failure code must be TIME_CONFLICT, got ${conflictRes.failureCode}`);
  assert(conflictRes.explanation.includes('Konflik jadwal'), 'Must explain time conflict in Indonesian');

  // ----------------------------------------------------
  // TEST 7: All-Day Event Handling
  // ----------------------------------------------------
  console.log('\n--- Test 7: All-Day Event blocks the day ---');
  const allDayHoliday: CalendarEvent = {
    id: 'holiday-1',
    provider: 'google',
    title: 'Hari Libur Nasional / Cuti Bersama',
    startAt: '2026-10-20T00:00:00.000Z',
    endAt: '2026-10-20T23:59:59.000Z',
    isAllDay: true,
    isEditable: false,
    syncStatus: 'synced',
  };

  const taskDuringHoliday: Task = {
    id: 'task-holiday',
    userId: 'user-default',
    title: 'Tugas di Hari Libur',
    estimatedDurationMinutes: 60,
    deadlineAt: createIsoFromLocalZoned(2026, 10, 20, 17, 0, 0, tz),
    priority: 'MEDIUM',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'deadline_only',
    createdAt: fixedBaseTime,
  };

  const holidayMorning = new Date(createIsoFromLocalZoned(2026, 10, 20, 8, 0, 0, tz));
  const holidayRes = scheduleTaskDeterministically(taskDuringHoliday, [allDayHoliday], [], defaultPreferences, holidayMorning);
  assert(!holidayRes.success, 'Task should fail to schedule during full-day holiday commitment');

  // ----------------------------------------------------
  // TEST 8: Flexible Evening Tasks ("tidur malam", "belajar malam", "olahraga malam")
  // ----------------------------------------------------
  console.log('\n--- Test 8: Flexible Evening Tasks ("tidur malam", "belajar malam", "olahraga malam") ---');
  const planTidur = parseIndonesianTemporalRules({
    userPrompt: 'Tidur malam 8 jam',
    currentDateTime: fixedBaseTime,
    userTimezone: tz,
  });
  assert(planTidur.timeConstraintType === 'preferred_window', 'tidur malam must be preferred_window, NOT fixed_event');
  assert(planTidur.preferredTimeOfDay === 'EVENING', 'preferredTimeOfDay must be EVENING');
  assert(planTidur.requestedStartAt === undefined, 'requestedStartAt must be undefined for flexible evening task');

  // ----------------------------------------------------
  // TEST 9: Accidental requestedStartAt on preferred_window must NEVER become fixed event
  // ----------------------------------------------------
  console.log('\n--- Test 9: Accidental requestedStartAt on preferred_window must NEVER become fixed event ---');
  const accidentalMorningStart = createIsoFromLocalZoned(2026, 10, 20, 5, 0, 0, tz); // 05:00 morning
  const accidentalMorningEnd = createIsoFromLocalZoned(2026, 10, 20, 6, 0, 0, tz);

  const hallucinatedTask: Task = {
    id: 'task-hallucinated',
    userId: 'user-default',
    title: 'Belajar Malam 60 Menit',
    estimatedDurationMinutes: 60,
    deadlineAt: createIsoFromLocalZoned(2026, 10, 20, 23, 59, 59, tz),
    priority: 'MEDIUM',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'preferred_window',
    preferredTimeOfDay: 'EVENING',
    preferredWindow: {
      startHour: 19,
      endHour: 23,
      label: 'Malam (19:00 - 23:00)',
    },
    requestedStartAt: accidentalMorningStart,
    requestedEndAt: accidentalMorningEnd,
    createdAt: fixedBaseTime,
  };

  const schedHallucinated = scheduleTaskDeterministically(hallucinatedTask, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(schedHallucinated.success, 'Scheduler should place evening task in evening slot');
  const placedSession = schedHallucinated.proposedSessions[0];
  const placedStartHour = getZonedDateTimeParts(new Date(placedSession.startAt), tz).hour;
  assert(
    placedStartHour >= 19 && placedStartHour <= 23,
    `Session must be scheduled in evening (19-23), NOT at hallucinated 05:00. Got: ${placedStartHour}:00`
  );
  assert(placedStartHour !== 5, 'CRITICAL: Must NEVER schedule flexible evening task at 05:00 morning!');

  // ----------------------------------------------------
  // TEST 10: Explicit Date and Range ("Kelas Kamis 22 Okt 19:00-22:00 WIB")
  // ----------------------------------------------------
  console.log('\n--- Test 10: "Kelas Kamis 22 Okt 19:00-22:00 WIB" (Explicit Date, 180 min) ---');
  const planExplicitClass = parseIndonesianTemporalRules({
    userPrompt: 'Kelas Kamis 22 Okt 19:00-22:00 WIB',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta (WIB)',
  });

  assert(planExplicitClass.timeConstraintType === 'fixed_event', 'Constraint type must be fixed_event');
  assert(planExplicitClass.estimatedDurationMinutes === 180, 'Duration must be 180 minutes');
  assert(Boolean(planExplicitClass.requestedStartAt && planExplicitClass.requestedEndAt), 'Must have start and end timestamp');

  const expStartParts = getZonedDateTimeParts(new Date(planExplicitClass.requestedStartAt!), tz);
  const expEndParts = getZonedDateTimeParts(new Date(planExplicitClass.requestedEndAt!), tz);

  assert(expStartParts.day === 22, `Target day must be 22, got ${expStartParts.day}`);
  assert(expStartParts.month === 10, `Target month must be 10 (Okt), got ${expStartParts.month}`);
  assert(expStartParts.hour === 19, `Start hour must be 19:00 WIB, got ${expStartParts.hour}`);
  assert(expEndParts.hour === 22, `End hour must be 22:00 WIB, got ${expEndParts.hour}`);

  // In UTC epoch: 19:00 WIB on 22 Oct 2026 is exactly 12:00:00.000Z
  const expectedUtcStart = '2026-10-22T12:00:00.000Z';
  const expectedUtcEnd = '2026-10-22T15:00:00.000Z';
  assert(planExplicitClass.requestedStartAt === expectedUtcStart, `Start UTC must match ${expectedUtcStart}, got ${planExplicitClass.requestedStartAt}`);
  assert(planExplicitClass.requestedEndAt === expectedUtcEnd, `End UTC must match ${expectedUtcEnd}, got ${planExplicitClass.requestedEndAt}`);

  // Schedule without collision
  const explicitTaskObj: Task = {
    id: 'task-kelas-22-okt',
    userId: 'user-1',
    title: 'Kelas Kamis 22 Okt',
    estimatedDurationMinutes: 180,
    deadlineAt: planExplicitClass.deadlineAt!,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'fixed_event',
    requestedStartAt: planExplicitClass.requestedStartAt,
    requestedEndAt: planExplicitClass.requestedEndAt,
    timezone: 'Asia/Jakarta',
    createdAt: fixedBaseTime,
  };

  const schedExpSuccess = scheduleTaskDeterministically(explicitTaskObj, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(schedExpSuccess.success, 'Explicit class task must schedule successfully when no collision');
  assert(schedExpSuccess.proposedSessions[0].startAt === expectedUtcStart, 'Start time must never drift to Friday or morning');

  // Schedule with collision
  const collisionEvent: CalendarEvent = {
    id: 'event-conflict-22-okt',
    provider: 'google',
    title: 'Webinar Desain Produk',
    startAt: '2026-10-22T13:00:00.000Z', // 20:00 WIB
    endAt: '2026-10-22T14:30:00.000Z',   // 21:30 WIB
    isEditable: false,
    syncStatus: 'synced',
  };

  const schedExpCollision = scheduleTaskDeterministically(explicitTaskObj, [collisionEvent], [], defaultPreferences, new Date(fixedBaseTime));
  assert(!schedExpCollision.success, 'Must fail when collision exists');
  assert(schedExpCollision.failureCode === 'TIME_CONFLICT', `Must report TIME_CONFLICT, got ${schedExpCollision.failureCode}`);
  assert(schedExpCollision.diagnostics?.conflictingEvents?.length === 1, 'Diagnostics must include the conflicting event');

  // ----------------------------------------------------
  // TEST 11: Normalizing Timezone Strings ("Asia/Jakarta (WIB)" -> "Asia/Jakarta")
  // ----------------------------------------------------
  console.log('\n--- Test 11: Normalizing Timezone Strings ---');
  assert(normalizeTimezone('Asia/Jakarta (WIB)') === 'Asia/Jakarta', 'Must normalize "Asia/Jakarta (WIB)"');
  assert(normalizeTimezone('Asia/Makassar (WITA)') === 'Asia/Makassar', 'Must normalize "Asia/Makassar (WITA)"');
  assert(normalizeTimezone('') === 'Asia/Jakarta', 'Empty timezone must fallback to Asia/Jakarta');

  console.log('\n========================================');
  console.log('🎉 ALL PARSER & SCHEDULER TESTS PASSED! 🎉');
  console.log('========================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
