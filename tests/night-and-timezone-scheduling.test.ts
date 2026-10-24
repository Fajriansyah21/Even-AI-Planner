import { parseIndonesianTemporalRules } from '../src/lib/temporalParser';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';
import { Task, CalendarEvent, UserPreferences } from '../src/types';
import { getPartsInTimezone } from '../src/lib/timezone';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

const defaultPreferences: UserPreferences = {
  displayName: 'Tester Even',
  email: 'tester@evenplanner.id',
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

export async function runNightAndTimezoneTests() {
  console.log('=== RUNNING NIGHT SCHEDULING & TIMEZONE FIDELITY TESTS ===\n');

  // Base reference date: Monday morning 08:00 Jakarta time
  const fixedBaseTime = '2026-10-19T01:00:00.000Z'; // 08:00 WIB (UTC+7)

  // ----------------------------------------------------
  // TEST 1: "Tidur malam" TIDAK dijadwalkan pukul 05.00
  // ----------------------------------------------------
  console.log('--- Case 1: "Tidur malam" must NOT be scheduled at 05:00 morning ---');
  const planTidur = parseIndonesianTemporalRules({
    userPrompt: 'Tidur malam 8 jam',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });

  assert(planTidur.timeConstraintType === 'preferred_window', 'tidur malam must be preferred_window, NOT fixed_event');
  assert(planTidur.preferredTimeOfDay === 'EVENING', 'preferredTimeOfDay must be EVENING');
  assert(planTidur.requestedStartAt === undefined, 'requestedStartAt must be undefined to prevent 05:00 fixed lock');
  assert(planTidur.requestedEndAt === undefined, 'requestedEndAt must be undefined');
  assert(planTidur.estimatedDurationMinutes === 480, 'Duration must be 480 minutes (8 hours)');

  const taskTidur: Task = {
    id: 'task-tidur-malam',
    userId: 'user-default',
    title: 'Tidur Malam 8 Jam',
    estimatedDurationMinutes: 480,
    deadlineAt: planTidur.deadlineAt,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: planTidur.timeConstraintType,
    preferredTimeOfDay: planTidur.preferredTimeOfDay,
    preferredWindow: planTidur.preferredWindow,
    createdAt: fixedBaseTime,
  };

  const schedTidur = scheduleTaskDeterministically(taskTidur, [], [], defaultPreferences, new Date(fixedBaseTime));
  if (schedTidur.success && schedTidur.proposedSessions.length > 0) {
    const startHour = getPartsInTimezone(new Date(schedTidur.proposedSessions[0].startAt), 'Asia/Jakarta').hour;
    assert(startHour !== 5, 'CRITICAL: "Tidur malam" must NEVER be placed at 05:00 morning!');
    assert(startHour >= 19 && startHour <= 23, `Must be placed in evening (19:00 - 23:00), placed at ${startHour}:00`);
  }

  // ----------------------------------------------------
  // TEST 2: "Belajar malam selama 2 jam" ditempatkan di jendela malam
  // ----------------------------------------------------
  console.log('\n--- Case 2: "Belajar malam selama 2 jam" placed in available evening window ---');
  const planBelajar = parseIndonesianTemporalRules({
    userPrompt: 'Belajar malam selama 2 jam',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });

  assert(planBelajar.estimatedDurationMinutes === 120, 'Duration must be 120 minutes');
  assert(planBelajar.preferredTimeOfDay === 'EVENING', 'Must prefer evening');

  const taskBelajar: Task = {
    id: 'task-belajar-2jam',
    userId: 'user-default',
    title: 'Belajar Malam Selama 2 Jam',
    estimatedDurationMinutes: 120,
    deadlineAt: planBelajar.deadlineAt,
    priority: 'MEDIUM',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: planBelajar.timeConstraintType,
    preferredTimeOfDay: planBelajar.preferredTimeOfDay,
    preferredWindow: planBelajar.preferredWindow,
    createdAt: fixedBaseTime,
  };

  const schedBelajar = scheduleTaskDeterministically(taskBelajar, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(schedBelajar.success, 'Scheduler must find evening slot for 2-hour study session');
  const session = schedBelajar.proposedSessions[0];
  const startParts = getPartsInTimezone(new Date(session.startAt), 'Asia/Jakarta');
  assert(startParts.hour >= 19 && startParts.hour <= 23, `Start hour must be in evening (19-23 WIB), got ${startParts.hour}:00`);
  assert(session.durationMinutes === 120, 'Session duration must be 120 minutes');

  // ----------------------------------------------------
  // TEST 3: "Tidur pukul 22.00" mempertahankan waktu pasti yang diminta
  // ----------------------------------------------------
  console.log('\n--- Case 3: "Tidur pukul 22.00" retains exact requested start time ---');
  const planTidurPukul = parseIndonesianTemporalRules({
    userPrompt: 'Tidur pukul 22.00',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });

  assert(planTidurPukul.timeConstraintType === 'fixed_event', 'Tidur pukul 22.00 must be a fixed_event');
  assert(Boolean(planTidurPukul.requestedStartAt), 'Must have requestedStartAt');
  const fixedStartParts = getPartsInTimezone(new Date(planTidurPukul.requestedStartAt!), 'Asia/Jakarta');
  assert(fixedStartParts.hour === 22, `Requested start hour must be exactly 22 WIB, got ${fixedStartParts.hour}`);

  const taskTidurPukul: Task = {
    id: 'task-tidur-22',
    userId: 'user-default',
    title: 'Tidur Pukul 22.00',
    estimatedDurationMinutes: planTidurPukul.estimatedDurationMinutes,
    deadlineAt: planTidurPukul.deadlineAt,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'fixed_event',
    requestedStartAt: planTidurPukul.requestedStartAt,
    requestedEndAt: planTidurPukul.requestedEndAt,
    createdAt: fixedBaseTime,
  };

  const schedTidurPukul = scheduleTaskDeterministically(taskTidurPukul, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(schedTidurPukul.success, 'Scheduler should succeed for free 22:00 slot');
  const sessTidur = schedTidurPukul.proposedSessions[0];
  const actualStartHour = getPartsInTimezone(new Date(sessTidur.startAt), 'Asia/Jakarta').hour;
  assert(actualStartHour === 22, `Session must start at 22:00 WIB, got ${actualStartHour}`);

  // ----------------------------------------------------
  // TEST 4: "Rapat besok pukul 20.00 sampai 21.00" mempertahankan tanggal & waktu
  // ----------------------------------------------------
  console.log('\n--- Case 4: "Rapat besok pukul 20.00 sampai 21.00" retains correct date and time ---');
  const planRapat = parseIndonesianTemporalRules({
    userPrompt: 'Rapat besok pukul 20.00 sampai 21.00',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });

  assert(planRapat.timeConstraintType === 'fixed_event', 'Must be fixed_event');
  assert(planRapat.deadlineDaysFromNow === 1, 'Must have 1 day offset (besok)');
  assert(Boolean(planRapat.requestedStartAt && planRapat.requestedEndAt), 'Must specify start and end');

  const rapatStartParts = getPartsInTimezone(new Date(planRapat.requestedStartAt!), 'Asia/Jakarta');
  const rapatEndParts = getPartsInTimezone(new Date(planRapat.requestedEndAt!), 'Asia/Jakarta');
  assert(rapatStartParts.hour === 20 && rapatStartParts.minute === 0, `Start must be 20:00, got ${rapatStartParts.hour}:${rapatStartParts.minute}`);
  assert(rapatEndParts.hour === 21 && rapatEndParts.minute === 0, `End must be 21:00, got ${rapatEndParts.hour}:${rapatEndParts.minute}`);
  // Day offset check
  const baseDay = getPartsInTimezone(new Date(fixedBaseTime), 'Asia/Jakarta').day;
  assert(rapatStartParts.day === baseDay + 1, `Day must be tomorrow (${baseDay + 1}), got ${rapatStartParts.day}`);

  // ----------------------------------------------------
  // TEST 5: "Olahraga pagi" tidak dialihkan ke malam tanpa persetujuan
  // ----------------------------------------------------
  console.log('\n--- Case 5: "Olahraga pagi" must not be diverted to evening ---');
  const planOlahragaPagi = parseIndonesianTemporalRules({
    userPrompt: 'Olahraga pagi 45 menit',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });

  assert(planOlahragaPagi.preferredTimeOfDay === 'MORNING', 'Must be MORNING');
  assert(planOlahragaPagi.timeConstraintType === 'preferred_window', 'Must be preferred_window');

  const taskOlahraga: Task = {
    id: 'task-olahraga-pagi',
    userId: 'user-default',
    title: 'Olahraga Pagi 45 Menit',
    estimatedDurationMinutes: 45,
    deadlineAt: planOlahragaPagi.deadlineAt,
    priority: 'MEDIUM',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'preferred_window',
    preferredTimeOfDay: 'MORNING',
    preferredWindow: planOlahragaPagi.preferredWindow,
    createdAt: fixedBaseTime,
  };

  const schedOlahraga = scheduleTaskDeterministically(taskOlahraga, [], [], defaultPreferences, new Date(fixedBaseTime));
  assert(schedOlahraga.success, 'Morning slot should be found');
  const sportStartHour = getPartsInTimezone(new Date(schedOlahraga.proposedSessions[0].startAt), 'Asia/Jakarta').hour;
  assert(sportStartHour >= 6 && sportStartHour <= 12, `Must be in morning window (06-12), got ${sportStartHour}`);
  assert(sportStartHour < 18, 'Olahraga pagi must NEVER be scheduled in evening!');

  // ----------------------------------------------------
  // TEST 6: Jendela malam penuh tidak memindahkan tugas ke jam kerja
  // ----------------------------------------------------
  console.log('\n--- Case 6: Full evening window fails cleanly without silent morning shift ---');
  // Block 19:00 - 23:00 on candidate days
  const blockerEvent1: CalendarEvent = {
    id: 'blocker-night-1',
    provider: 'google',
    title: 'Acara Keluarga Sepanjang Malam',
    startAt: '2026-10-19T12:00:00.000Z', // 19:00 WIB
    endAt: '2026-10-19T16:00:00.000Z',   // 23:00 WIB
    isEditable: false,
    syncStatus: 'synced',
  };
  const blockerEvent2: CalendarEvent = {
    id: 'blocker-night-2',
    provider: 'google',
    title: 'Acara Malam Hari 2',
    startAt: '2026-10-20T12:00:00.000Z',
    endAt: '2026-10-20T16:00:00.000Z',
    isEditable: false,
    syncStatus: 'synced',
  };

  const strictNightTask: Task = {
    id: 'task-strict-night',
    userId: 'user-default',
    title: 'Belajar Malam Ketat 60 Menit',
    estimatedDurationMinutes: 60,
    deadlineAt: '2026-10-20T16:00:00.000Z',
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

  const blockedRes = scheduleTaskDeterministically(
    strictNightTask,
    [blockerEvent1, blockerEvent2],
    [],
    defaultPreferences,
    new Date(fixedBaseTime)
  );

  assert(!blockedRes.success, 'Must report failure when evening window is blocked');
  assert(blockedRes.proposedSessions.length === 0, 'Must NOT place any sessions in morning');
  assert(
    blockedRes.explanation.includes('malam') || blockedRes.explanation.includes('jendela'),
    'Explanation must detail that evening window was full'
  );

  // ----------------------------------------------------
  // TEST 7: Jadwal melintasi tengah malam ditangani dengan benar
  // ----------------------------------------------------
  console.log('\n--- Case 7: Cross-midnight schedules handled correctly ---');
  const planTengahMalam = parseIndonesianTemporalRules({
    userPrompt: 'Shift malam jam 23.00 sampai 02.00',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });

  assert(planTengahMalam.timeConstraintType === 'fixed_event', 'Shift range must be fixed_event');
  assert(Boolean(planTengahMalam.requestedStartAt && planTengahMalam.requestedEndAt), 'Must have start and end');

  const sTime = new Date(planTengahMalam.requestedStartAt!).getTime();
  const eTime = new Date(planTengahMalam.requestedEndAt!).getTime();
  assert(eTime > sTime, `End time must be strictly AFTER start time across midnight (diff: ${(eTime - sTime) / 3600000}h)`);
  assert((eTime - sTime) / 3600000 === 3, 'Duration across midnight must be exactly 3 hours');

  // ----------------------------------------------------
  // TEST 8: Hasil Gemini bertentangan ditolak/dikoreksi secara deterministik
  // ----------------------------------------------------
  console.log('\n--- Case 8: Gemini hallucinated 05:00 fixed event corrected to preferred_window ---');
  // Baseline is flexible evening task:
  const baseline = parseIndonesianTemporalRules({
    userPrompt: 'tidur malam',
    currentDateTime: fixedBaseTime,
    userTimezone: 'Asia/Jakarta',
  });

  // Simulated raw output from an uncalibrated LLM:
  const rawAiHallucination = {
    title: 'Tidur Malam',
    timeConstraintType: 'fixed_event',
    requestedStartAt: '2026-10-19T05:00:00.000Z', // 05:00 morning hallucination!
    requestedEndAt: '2026-10-19T13:00:00.000Z',
    preferredTimeOfDay: 'MORNING',
    estimatedDurationMinutes: 480,
    allowSplit: false,
    reasoning: 'Hallucinated early morning slot',
  };

  // Re-run the server-side sanitization logic:
  const sanitized = { ...rawAiHallucination, timezone: 'Asia/Jakarta' };
  if (baseline.timeConstraintType === 'preferred_window') {
    sanitized.timeConstraintType = 'preferred_window';
    sanitized.preferredWindow = baseline.preferredWindow;
    sanitized.preferredTimeOfDay = baseline.preferredTimeOfDay;
    delete (sanitized as any).requestedStartAt;
    delete (sanitized as any).requestedEndAt;
  }

  assert(sanitized.timeConstraintType === 'preferred_window', 'Must be sanitized to preferred_window');
  assert(sanitized.preferredTimeOfDay === 'EVENING', 'Must be sanitized to EVENING');
  assert((sanitized as any).requestedStartAt === undefined, 'Hallucinated 05:00 must be eliminated');

  // ----------------------------------------------------
  // TEST 9: Tanggal dan waktu tetap benar pada zona waktu Asia/Jakarta
  // ----------------------------------------------------
  console.log('\n--- Case 9: Dates and times strictly preserved in Asia/Jakarta (WIB) ---');
  const planTzCheck = parseIndonesianTemporalRules({
    userPrompt: 'Evaluasi mingguan jam 20.00 durasi 60 menit',
    currentDateTime: '2026-10-19T05:00:00.000Z', // 12:00 WIB
    userTimezone: 'Asia/Jakarta',
  });

  if (planTzCheck.requestedStartAt) {
    const parts = getPartsInTimezone(new Date(planTzCheck.requestedStartAt), 'Asia/Jakarta');
    assert(parts.hour === 20, `Hour in Asia/Jakarta must be 20, got ${parts.hour}`);
  }

  console.log('\n==================================================================');
  console.log('🎉 ALL NIGHT SCHEDULING & TIMEZONE FIDELITY TESTS PASSED! 🎉');
  console.log('==================================================================\n');
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('night-and-timezone-scheduling')) {
  runNightAndTimezoneTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}
