process.env.TZ = 'Asia/Jakarta';

import { parseIndonesianTemporalRules } from '../src/lib/temporalParser';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';
import { Task, CalendarEvent, UserPreferences } from '../src/types';

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

  const fixedBaseTime = '2026-10-19T08:00:00.000Z'; // Reference date: Monday morning

  // ----------------------------------------------------
  // TEST 1: Fixed Event Interpretation (19:00 - 22:00)
  // ----------------------------------------------------
  console.log('\n--- Test 1: "Malam ini ada kelas jam 7 malam sampai jam 10 malam" ---');
  const plan1 = parseIndonesianTemporalRules({
    userPrompt: 'Malam ini ada kelas jam 7 malam sampai jam 10 malam',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });

  assert(plan1.timeConstraintType === 'fixed_event', 'Constraint type must be fixed_event');
  assert(plan1.estimatedDurationMinutes === 180, 'Duration must be 180 minutes (3 hours)');
  assert(!plan1.allowSplit, 'Fixed event must never allow split');
  assert(Boolean(plan1.requestedStartAt && plan1.requestedEndAt), 'Must have start and end time');

  const startD1 = new Date(plan1.requestedStartAt!);
  const endD1 = new Date(plan1.requestedEndAt!);
  assert(startD1.getHours() === 19, `Start hour must be 19 (7 PM), got ${startD1.getHours()}`);
  assert(endD1.getHours() === 22, `End hour must be 22 (10 PM), got ${endD1.getHours()}`);

  // ----------------------------------------------------
  // TEST 2: Anti-regression 09.00 vs 21.00 (9 malam vs 9 pagi)
  // ----------------------------------------------------
  console.log('\n--- Test 2: "Malam ini jam 9 belajar materi React 45 menit" & "pukul 21.00" ---');
  const plan2 = parseIndonesianTemporalRules({
    userPrompt: 'Malam ini jam 9 belajar materi React 45 menit',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });

  assert(plan2.preferredTimeOfDay === 'EVENING', 'Must be classified as EVENING, never MORNING');
  if (plan2.requestedStartAt) {
    const sH = new Date(plan2.requestedStartAt).getHours();
    assert(sH === 21, `Requested start hour must be 21, not 9. Got ${sH}`);
  }

  const plan2b = parseIndonesianTemporalRules({
    userPrompt: 'Tugas evaluasi sistem pukul 21.00 durasi 60 menit',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });
  if (plan2b.requestedStartAt) {
    const sH2b = new Date(plan2b.requestedStartAt).getHours();
    assert(sH2b === 21, `Pukul 21.00 must parse to hour 21, got ${sH2b}`);
  }

  const planMorning = parseIndonesianTemporalRules({
    userPrompt: 'Diskusi jam 9 pagi durasi 60 menit',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });
  assert(planMorning.preferredTimeOfDay === 'MORNING', 'Pagi must parse as MORNING');
  if (planMorning.requestedStartAt) {
    const sHM = new Date(planMorning.requestedStartAt).getHours();
    assert(sHM === 9, `Jam 9 pagi must parse to hour 9, got ${sHM}`);
  }

  // ----------------------------------------------------
  // TEST 3: Date Rollover ("besok malam", "lusa")
  // ----------------------------------------------------
  console.log('\n--- Test 3: Date Rollover ("besok malam", "lusa") ---');
  const planBesok = parseIndonesianTemporalRules({
    userPrompt: 'Jadwalkan tugas 60 menit besok malam',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });
  assert(planBesok.preferredTimeOfDay === 'EVENING', 'Besok malam must have EVENING preference');
  assert(planBesok.deadlineDaysFromNow === 1, `Day offset for besok must be 1, got ${planBesok.deadlineDaysFromNow}`);

  const planLusa = parseIndonesianTemporalRules({
    userPrompt: 'Laporan keuangan lusa jam 14.00',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });
  assert(planLusa.deadlineDaysFromNow === 2, `Day offset for lusa must be 2, got ${planLusa.deadlineDaysFromNow}`);

  // ----------------------------------------------------
  // TEST 4: Scheduler Enforces Preferred Window (Evening Task)
  // ----------------------------------------------------
  console.log('\n--- Test 4: Scheduler handles "tugas 60 menit besok malam" without shifting to morning ---');
  const tomorrow = new Date(fixedBaseTime);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowEveningDeadline = new Date(tomorrow);
  tomorrowEveningDeadline.setHours(23, 59, 59, 999);

  const eveningTask: Task = {
    id: 'task-besok-malam',
    userId: 'user-default',
    title: 'Tugas 60 Menit Besok Malam',
    estimatedDurationMinutes: 60,
    deadlineAt: tomorrowEveningDeadline.toISOString(),
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
    timezone: 'Asia/Jakarta',
    createdAt: fixedBaseTime,
  };

  const schedRes = scheduleTaskDeterministically(eveningTask, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(schedRes.success, 'Scheduler should find evening slot');
  assert(schedRes.proposedSessions.length === 1, 'Should have 1 session');

  const placedStart = new Date(schedRes.proposedSessions[0].startAt);
  const placedHour = placedStart.getHours();
  assert(placedHour >= 19 && placedHour <= 22, `Session must be placed in evening (19-22), but was placed at ${placedHour}:00!`);
  assert(placedHour !== 9, 'CRITICAL: Evening task must NEVER be scheduled at 09:00 morning!');

  // ----------------------------------------------------
  // TEST 5: Scheduler Rejects Shifts When Constraint Cannot Be Met
  // ----------------------------------------------------
  // Block the entire evening 19:00 - 23:00 on both candidate days (Monday and Tuesday)
  const blockingEventMonday: CalendarEvent = {
    id: 'blocker-mon',
    provider: 'google',
    title: 'Acara Keluarga Senin Malam',
    startAt: new Date(new Date(fixedBaseTime).setHours(19, 0, 0, 0)).toISOString(),
    endAt: new Date(new Date(fixedBaseTime).setHours(23, 0, 0, 0)).toISOString(),
    isEditable: false,
    syncStatus: 'synced',
  };
  const blockingEvent: CalendarEvent = {
    id: 'blocker-1',
    provider: 'google',
    title: 'Acara Keluarga Sepanjang Malam',
    startAt: new Date(new Date(tomorrow).setHours(19, 0, 0, 0)).toISOString(),
    endAt: new Date(new Date(tomorrow).setHours(23, 0, 0, 0)).toISOString(),
    isEditable: false,
    syncStatus: 'synced',
  };

  // With evening blocked and strict window, scheduler must fail with explanation, NOT jump to morning 09:00
  const strictEveningTask: Task = {
    ...eveningTask,
    deadlineAt: new Date(new Date(tomorrow).setHours(22, 0, 0, 0)).toISOString(),
  };

  const blockedRes = scheduleTaskDeterministically(strictEveningTask, [blockingEventMonday, blockingEvent], [], defaultPreferences, new Date(fixedBaseTime));
  assert(!blockedRes.success, 'Successfully reported inability to schedule without silent morning displacement');
  assert(blockedRes.explanation.length > 0, 'Must provide clear Indonesian explanation');

  // ----------------------------------------------------
  // TEST 6: Fixed Event Cannot Be Moved
  // ----------------------------------------------------
  console.log('\n--- Test 6: Fixed event cannot be moved ---');
  const classStart = new Date(tomorrow);
  classStart.setHours(19, 0, 0, 0);
  const classEnd = new Date(tomorrow);
  classEnd.setHours(22, 0, 0, 0);

  const fixedClassTask: Task = {
    id: 'task-kelas-tetap',
    userId: 'user-default',
    title: 'Kelas Malam Tetap',
    estimatedDurationMinutes: 180,
    deadlineAt: classEnd.toISOString(),
    priority: 'URGENT',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'fixed_event',
    requestedStartAt: classStart.toISOString(),
    requestedEndAt: classEnd.toISOString(),
    createdAt: fixedBaseTime,
  };

  // Case A: Free evening -> placed exactly at requested start and end
  const freeRes = scheduleTaskDeterministically(fixedClassTask, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(freeRes.success, 'Fixed event should succeed when slot is free');
  const sess = freeRes.proposedSessions[0];
  assert(new Date(sess.startAt).getTime() === classStart.getTime(), 'Fixed event must start exactly at requested time');
  assert(new Date(sess.endAt).getTime() === classEnd.getTime(), 'Fixed event must end exactly at requested time');

  // Case B: Conflicting event overlaps -> must return success: false and NOT shift
  const overlapMeeting: CalendarEvent = {
    id: 'meeting-overlap',
    provider: 'google',
    title: 'Rapat Koordinasi 20:00 - 21:00',
    startAt: new Date(new Date(tomorrow).setHours(20, 0, 0, 0)).toISOString(),
    endAt: new Date(new Date(tomorrow).setHours(21, 0, 0, 0)).toISOString(),
    isEditable: false,
    syncStatus: 'synced',
  };

  const conflictRes = scheduleTaskDeterministically(fixedClassTask, [overlapMeeting], [], defaultPreferences, new Date(fixedBaseTime));
  assert(!conflictRes.success, 'Fixed event with conflict must report failure (cannot be shifted)');
  assert(conflictRes.explanation.includes('konflik') || conflictRes.explanation.includes('Rapat Koordinasi'), 'Must detail the conflicting event');

  // ----------------------------------------------------
  // TEST 7: All-Day Event Handling
  // ----------------------------------------------------
  console.log('\n--- Test 7: All-Day Event blocks the day ---');
  const allDayHoliday: CalendarEvent = {
    id: 'holiday-1',
    provider: 'google',
    title: 'Hari Libur Nasional / Cuti Bersama',
    startAt: `${tomorrow.toISOString().split('T')[0]}T00:00:00.000Z`,
    endAt: `${tomorrow.toISOString().split('T')[0]}T23:59:59.000Z`,
    isAllDay: true,
    isEditable: false,
    syncStatus: 'synced',
  };

  const taskDuringHoliday: Task = {
    id: 'task-holiday',
    userId: 'user-default',
    title: 'Tugas di Hari Libur',
    estimatedDurationMinutes: 60,
    deadlineAt: new Date(new Date(tomorrow).setHours(17, 0, 0, 0)).toISOString(),
    priority: 'MEDIUM',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'deadline_only',
    createdAt: fixedBaseTime,
  };

  const holidayMorning = new Date(tomorrow);
  holidayMorning.setHours(8, 0, 0, 0);

  const holidayRes = scheduleTaskDeterministically(taskDuringHoliday, [allDayHoliday], [], defaultPreferences, holidayMorning);
  assert(!holidayRes.success, 'Task should fail to schedule during full-day holiday commitment');

  // ----------------------------------------------------
  // TEST 8: Flexible Evening Tasks ("tidur malam", "belajar malam", "olahraga malam")
  // ----------------------------------------------------
  console.log('\n--- Test 8: Flexible Evening Tasks ("tidur malam", "belajar malam", "olahraga malam") ---');
  const planTidur = parseIndonesianTemporalRules({
    userPrompt: 'Tidur malam 8 jam',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });
  assert(planTidur.timeConstraintType === 'preferred_window', 'tidur malam must be preferred_window, NOT fixed_event');
  assert(planTidur.preferredTimeOfDay === 'EVENING', 'preferredTimeOfDay must be EVENING');
  assert(planTidur.requestedStartAt === undefined, 'requestedStartAt must be undefined for flexible evening task');
  assert(planTidur.requestedEndAt === undefined, 'requestedEndAt must be undefined for flexible evening task');

  const planBelajar = parseIndonesianTemporalRules({
    userPrompt: 'Belajar malam 45 menit',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });
  assert(planBelajar.timeConstraintType === 'preferred_window', 'belajar malam must be preferred_window');
  assert(planBelajar.preferredTimeOfDay === 'EVENING', 'preferredTimeOfDay must be EVENING');
  assert(planBelajar.requestedStartAt === undefined, 'requestedStartAt must be undefined');

  const planOlahraga = parseIndonesianTemporalRules({
    userPrompt: 'Olahraga malam 30 menit',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });
  assert(planOlahraga.timeConstraintType === 'preferred_window', 'olahraga malam must be preferred_window');
  assert(planOlahraga.requestedStartAt === undefined, 'requestedStartAt must be undefined');

  // ----------------------------------------------------
  // TEST 9: Accidental requestedStartAt on preferred_window must NEVER become fixed_event at 05:00
  // ----------------------------------------------------
  console.log('\n--- Test 9: Accidental requestedStartAt on preferred_window must NEVER become fixed event ---');
  const accidentalMorningStart = new Date(tomorrow);
  accidentalMorningStart.setHours(5, 0, 0, 0); // 05:00 morning hallucination
  const accidentalMorningEnd = new Date(tomorrow);
  accidentalMorningEnd.setHours(6, 0, 0, 0);

  const hallucinatedTask: Task = {
    id: 'task-hallucinated',
    userId: 'user-default',
    title: 'Belajar Malam 60 Menit',
    estimatedDurationMinutes: 60,
    deadlineAt: new Date(new Date(tomorrow).setHours(23, 59, 59, 999)).toISOString(),
    priority: 'MEDIUM',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'preferred_window', // Explicitly preferred_window!
    preferredTimeOfDay: 'EVENING',
    preferredWindow: {
      startHour: 19,
      endHour: 23,
      label: 'Malam (19:00 - 23:00)',
    },
    requestedStartAt: accidentalMorningStart.toISOString(), // Hallucinated morning timestamp!
    requestedEndAt: accidentalMorningEnd.toISOString(),
    createdAt: fixedBaseTime,
  };

  const schedHallucinated = scheduleTaskDeterministically(hallucinatedTask, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(schedHallucinated.success, 'Scheduler should place evening task in evening slot');
  const placedSession = schedHallucinated.proposedSessions[0];
  const placedStartHour = new Date(placedSession.startAt).getHours();
  assert(
    placedStartHour >= 19 && placedStartHour <= 23,
    `Session must be scheduled in evening (19-23), NOT at hallucinated 05:00. Got: ${placedStartHour}:00`
  );
  assert(placedStartHour !== 5, 'CRITICAL: Must NEVER schedule flexible evening task at 05:00 morning!');

  // ----------------------------------------------------
  // TEST 10: Evening task strictly rejected instead of jumping to 09:00 morning when evening is full
  // ----------------------------------------------------
  console.log('\n--- Test 10: Evening task rejected when evening is full (no silent jump to 09:00) ---');
  const eveningBlocker: CalendarEvent = {
    id: 'blocker-full-evening',
    provider: 'google',
    title: 'Kegiatan Malam Lengkap',
    startAt: new Date(new Date(tomorrow).setHours(19, 0, 0, 0)).toISOString(),
    endAt: new Date(new Date(tomorrow).setHours(23, 0, 0, 0)).toISOString(),
    isEditable: false,
    syncStatus: 'synced',
  };

  const blockedEveningTask: Task = {
    id: 'task-blocked-evening',
    userId: 'user-default',
    title: 'Tidur Malam 60 Menit',
    estimatedDurationMinutes: 60,
    deadlineAt: new Date(new Date(tomorrow).setHours(23, 0, 0, 0)).toISOString(),
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'preferred_window',
    preferredTimeOfDay: 'EVENING',
    preferredWindow: {
      startHour: 19,
      endHour: 23,
      label: 'Malam (19:00 - 23:00)',
    },
    createdAt: fixedBaseTime,
  };

  const tuesdayMorning = new Date(tomorrow);
  tuesdayMorning.setHours(8, 0, 0, 0);

  const blockedEveningRes = scheduleTaskDeterministically(blockedEveningTask, [eveningBlocker], [], defaultPreferences, tuesdayMorning);
  assert(!blockedEveningRes.success, 'Evening task with full evening must fail, not jump to morning 09:00');
  assert(
    blockedEveningRes.explanation.includes('malam') || blockedEveningRes.explanation.includes('jendela'),
    'Explanation must clearly mention evening window was full'
  );

  console.log('\n========================================');
  console.log('🎉 ALL PARSER & SCHEDULER TESTS PASSED! 🎉');
  console.log('========================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
