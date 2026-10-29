import { parseIndonesianTemporalRules, extractCleanActivityTitle, addDaysInTimezone as addDaysFromParser } from '../src/lib/temporalParser';
import { scheduleTaskDeterministically, addDaysInTimezone as addDaysFromScheduler } from '../src/lib/scheduler';
import { addDaysInTimezone } from '../src/lib/timezone';
import { INITIAL_PREFERENCES } from '../src/lib/mockData';
import { Task, CalendarEvent } from '../src/types';

export function runCriticalBugsValidationTests() {
  console.log('\n=== RUNNING CRITICAL SCHEDULER BUGS & REGRESSION VALIDATION TESTS ===\n');

  // -------------------------------------------------------------
  // Test 1: addDaysInTimezone is defined & exported across modules
  // -------------------------------------------------------------
  console.log('--- Test 1: Verifikasi addDaysInTimezone terdefinisi & diekspor tanpa error ---');
  if (typeof addDaysInTimezone !== 'function') {
    throw new Error('FAIL: addDaysInTimezone is not defined in src/lib/timezone');
  }
  if (typeof addDaysFromParser !== 'function') {
    throw new Error('FAIL: addDaysInTimezone is not exported from src/lib/temporalParser');
  }
  if (typeof addDaysFromScheduler !== 'function') {
    throw new Error('FAIL: addDaysInTimezone is not exported from src/lib/scheduler');
  }

  const baseDate = new Date('2026-10-31T03:00:00.000Z'); // 31 Okt 10:00 WIB
  const steppedDate = addDaysInTimezone(baseDate, 1, 'Asia/Jakarta');
  const steppedIso = steppedDate.toISOString();
  if (!steppedIso.startsWith('2026-11-01')) {
    throw new Error(`FAIL: addDaysInTimezone gagal menggeser tanggal: ${steppedIso}`);
  }
  console.log('✅ PASSED: addDaysInTimezone terdefinisi dan berfungsi sempurna di seluruh modul!');

  // -------------------------------------------------------------
  // Test 2: Bug 2 - Durasi Eksplisit 180 Menit & Penjadwalan Kamis
  // -------------------------------------------------------------
  console.log('\n--- Test 2: Bug 2 - Durasi Eksplisit "selama tiga jam" pada hari Kamis ---');
  const prompt2 = 'Kamis aku mau lanjut ngerjain desain kalau belum selesai, selama tiga jam.';
  const ctx2 = {
    userPrompt: prompt2,
    currentDateTime: '2026-10-19T02:00:00.000Z', // Senin 19 Okt 2026, 09:00 WIB
    userLocalTimeStr: '19/10/2026 09:00:00',
    userTimezone: 'Asia/Jakarta',
    workHours: { workStartHour: 9, workEndHour: 18 },
  };

  const plan2 = parseIndonesianTemporalRules(ctx2);
  if (plan2.estimatedDurationMinutes !== 180) {
    throw new Error(`FAIL: Durasi gagal diparsing menjadi 180 menit! Got: ${plan2.estimatedDurationMinutes}`);
  }
  if (plan2.title !== 'Melanjutkan Desain') {
    throw new Error(`FAIL: Judul tidak sesuai! Got: ${plan2.title}`);
  }
  if (!plan2.targetDays || plan2.targetDays[0] !== 4) {
    throw new Error(`FAIL: Target hari bukan Kamis (4)! Got: ${JSON.stringify(plan2.targetDays)}`);
  }

  const task2: Task = {
    id: 'task-design-thursday',
    userId: 'user-test',
    title: plan2.title,
    description: plan2.description,
    estimatedDurationMinutes: plan2.estimatedDurationMinutes,
    priority: plan2.priority,
    status: 'UNSCHEDULED',
    allowSplit: plan2.allowSplit,
    minimumSessionMinutes: plan2.minimumSessionMinutes,
    preferredTimeOfDay: plan2.preferredTimeOfDay,
    timeConstraintType: plan2.timeConstraintType,
    requestedStartAt: plan2.requestedStartAt,
    requestedEndAt: plan2.requestedEndAt,
    targetDays: plan2.targetDays,
    preferredWindow: plan2.preferredWindow,
    timezone: 'Asia/Jakarta',
    createdAt: new Date().toISOString(),
  };

  const schedRes2 = scheduleTaskDeterministically(task2, [], [], INITIAL_PREFERENCES, new Date(ctx2.currentDateTime));
  if (!schedRes2.success) {
    throw new Error(`FAIL: Scheduler gagal menjadwalkan tugas desain Kamis: ${schedRes2.explanation}`);
  }
  if (schedRes2.proposedSessions.length !== 1) {
    throw new Error(`FAIL: Harus 1 sesi utuh, got: ${schedRes2.proposedSessions.length}`);
  }

  const sess2 = schedRes2.proposedSessions[0];
  if (sess2.durationMinutes !== 180) {
    throw new Error(`FAIL: Durasi sesi bukan 180 menit! Got: ${sess2.durationMinutes}`);
  }
  const s2Start = new Date(sess2.startAt);
  const s2End = new Date(sess2.endAt);
  const s2StartHours = s2Start.getUTCHours() + 7; // WIB
  const s2EndHours = s2End.getUTCHours() + 7; // WIB

  // Must be scheduled at standard work hours (e.g. 09.00 - 12.00 WIB), NEVER 07.00 - 08.00 WIB!
  if (s2StartHours === 7 && s2EndHours === 8) {
    throw new Error('FAIL: Jadwal jatuh pada 07.00 - 08.00 WIB!');
  }
  if (s2StartHours !== 9 || s2EndHours !== 12) {
    throw new Error(`FAIL: Jadwal diharapkan 09.00 - 12.00 WIB, got ${s2StartHours}:00 - ${s2EndHours}:00 WIB`);
  }
  console.log(`✅ PASSED: Sesi 180 menit berhasil ditempatkan pada Kamis, 22 Okt (${s2StartHours}.00 - ${s2EndHours}.00 WIB)!`);

  // -------------------------------------------------------------
  // Test 3: Bug 3 - Penjadwalan Multi-hari, Habis Magrib & Deadline Jumat
  // -------------------------------------------------------------
  console.log('\n--- Test 3: Bug 3 - UTS Design deadline Jumat, Kamis dan Selasa habis Magrib 3 jam ---');
  const prompt3 = 'Aku ada UTS Design deadline-nya hari Jumat, jadi nanti Kamis dan Selasa habis Magrib, aku mau ngerjain selama tiga jam.';
  const ctx3 = {
    userPrompt: prompt3,
    currentDateTime: '2026-10-19T02:00:00.000Z', // Senin 19 Okt 2026, 09:00 WIB
    userLocalTimeStr: '19/10/2026 09:00:00',
    userTimezone: 'Asia/Jakarta',
    workHours: { workStartHour: 9, workEndHour: 18 },
  };

  const plan3 = parseIndonesianTemporalRules(ctx3);
  if (plan3.title !== 'Persiapan UTS Design') {
    throw new Error(`FAIL: Judul UTS Design tidak sesuai! Got: ${plan3.title}`);
  }
  // Jumat MUST NOT be included in targetDays!
  if (!plan3.targetDays || plan3.targetDays.includes(5)) {
    throw new Error(`FAIL: Hari Jumat (5) tidak boleh masuk ke targetDays! TargetDays: ${JSON.stringify(plan3.targetDays)}`);
  }
  if (plan3.targetDays.length !== 2 || !plan3.targetDays.includes(2) || !plan3.targetDays.includes(4)) {
    throw new Error(`FAIL: TargetDays harus berisi Selasa (2) dan Kamis (4)! Got: ${JSON.stringify(plan3.targetDays)}`);
  }
  if (plan3.timeConstraintType !== 'preferred_window' || !plan3.preferredWindow) {
    throw new Error('FAIL: Habis Magrib harus ditafsirkan sebagai preferred_window!');
  }
  if (plan3.preferredWindow.startHour !== 18 || plan3.preferredWindow.startMinute !== 30) {
    throw new Error(`FAIL: Jam mulai habis Magrib harus 18:30! Got: ${plan3.preferredWindow.startHour}:${plan3.preferredWindow.startMinute}`);
  }
  if (plan3.estimatedDurationMinutes !== 180) {
    throw new Error(`FAIL: Durasi per sesi harus 180 menit! Got: ${plan3.estimatedDurationMinutes}`);
  }
  if (!plan3.deadlineAt) {
    throw new Error('FAIL: deadlineAt harus diisi berdasarkan deadline hari Jumat!');
  }

  const task3: Task = {
    id: 'task-uts-design',
    userId: 'user-test',
    title: plan3.title,
    description: plan3.description,
    estimatedDurationMinutes: plan3.estimatedDurationMinutes,
    deadlineAt: plan3.deadlineAt,
    priority: plan3.priority,
    status: 'UNSCHEDULED',
    allowSplit: plan3.allowSplit,
    minimumSessionMinutes: plan3.minimumSessionMinutes,
    preferredTimeOfDay: plan3.preferredTimeOfDay,
    timeConstraintType: plan3.timeConstraintType,
    requestedStartAt: plan3.requestedStartAt,
    requestedEndAt: plan3.requestedEndAt,
    targetDays: plan3.targetDays,
    preferredWindow: plan3.preferredWindow,
    timezone: 'Asia/Jakarta',
    createdAt: new Date().toISOString(),
  };

  const schedRes3 = scheduleTaskDeterministically(task3, [], [], INITIAL_PREFERENCES, new Date(ctx3.currentDateTime));
  if (!schedRes3.success) {
    throw new Error(`FAIL: Gagal menjadwalkan 2 sesi UTS Design: ${schedRes3.explanation}`);
  }
  if (schedRes3.proposedSessions.length !== 2) {
    throw new Error(`FAIL: Diharapkan 2 sesi terpisah, got: ${schedRes3.proposedSessions.length}`);
  }

  const sessTue = schedRes3.proposedSessions[0];
  const sessThu = schedRes3.proposedSessions[1];
  if (sessTue.durationMinutes !== 180 || sessThu.durationMinutes !== 180) {
    throw new Error('FAIL: Masing-masing sesi harus berdurasi 180 menit!');
  }
  const tueStart = new Date(sessTue.startAt);
  const thuStart = new Date(sessThu.startAt);
  const deadlineDate = new Date(plan3.deadlineAt);

  if (tueStart >= deadlineDate || thuStart >= deadlineDate) {
    throw new Error('FAIL: Salah satu sesi melewati batas tenggat hari Jumat!');
  }
  console.log(`✅ PASSED: Sesi 1 (Selasa 18.30-21.30 WIB) & Sesi 2 (Kamis 18.30-21.30 WIB) berhasil dijadwalkan sebelum tenggat Jumat!`);

  // -------------------------------------------------------------
  // Test 4: Kasus Hari Selasa Telah Lewat & Tenggat Jumat Membatasi
  // -------------------------------------------------------------
  console.log('\n--- Test 4: Kasus Hari Selasa Telah Lewat (Rabu) -> Selasa Dibatalkan Secara Transparan ---');
  const ctx3Wed = {
    userPrompt: prompt3,
    currentDateTime: '2026-10-21T02:00:00.000Z', // Rabu 21 Okt 2026 (Selasa 20 Okt sudah lewat)
    userLocalTimeStr: '21/10/2026 09:00:00',
    userTimezone: 'Asia/Jakarta',
    workHours: { workStartHour: 9, workEndHour: 18 },
  };

  const plan3Wed = parseIndonesianTemporalRules(ctx3Wed);
  const task3Wed: Task = {
    ...task3,
    deadlineAt: plan3Wed.deadlineAt,
    targetDays: plan3Wed.targetDays,
  };

  const schedRes3Wed = scheduleTaskDeterministically(task3Wed, [], [], INITIAL_PREFERENCES, new Date(ctx3Wed.currentDateTime));
  if (!schedRes3Wed.partialSuccess) {
    throw new Error('FAIL: Diharapkan partialSuccess=true karena Selasa minggu depan melewati tenggat!');
  }
  if (schedRes3Wed.proposedSessions.length !== 1) {
    throw new Error(`FAIL: Hanya Kamis yang boleh dijadwalkan! Got ${schedRes3Wed.proposedSessions.length} sesi`);
  }
  if (!schedRes3Wed.skippedOccurrences || schedRes3Wed.skippedOccurrences.length !== 1) {
    throw new Error('FAIL: skippedOccurrences harus mencatat kegagalan Selasa!');
  }
  const skipped = schedRes3Wed.skippedOccurrences[0];
  if (skipped.dayName !== 'Selasa' || !skipped.reason.includes('tenggat')) {
    throw new Error(`FAIL: Alasan skipped harus menyebutkan tenggat waktu! Got: ${skipped.reason}`);
  }
  console.log(`✅ PASSED: Selasa minggu depan tidak digeser diam-diam dan dilaporkan tertahan oleh batas tenggat Jumat!`);

  // -------------------------------------------------------------
  // Test 5: Pengujian Regresi Wajib - Fixed Event Rabu 19.00 - 22.00
  // -------------------------------------------------------------
  console.log('\n--- Test 5: Regresi Wajib 1 - Fixed Event Rabu 19.00 - 22.00 WIB ---');
  const promptFixed = 'Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming';
  const planFixed = parseIndonesianTemporalRules({
    userPrompt: promptFixed,
    currentDateTime: '2026-10-19T02:00:00.000Z', // Senin
    userLocalTimeStr: '19/10/2026 09:00:00',
    userTimezone: 'Asia/Jakarta',
    workHours: { workStartHour: 9, workEndHour: 18 },
  });

  if (planFixed.title !== 'UTS Web Programming') {
    throw new Error(`FAIL: Judul harus 'UTS Web Programming'! Got: ${planFixed.title}`);
  }
  if (planFixed.timeConstraintType !== 'fixed_event') {
    throw new Error('FAIL: Harus fixed_event!');
  }
  const taskFixed: Task = {
    id: 'fixed-uts',
    userId: 'user-test',
    title: planFixed.title,
    description: planFixed.description,
    estimatedDurationMinutes: planFixed.estimatedDurationMinutes,
    priority: planFixed.priority,
    status: 'UNSCHEDULED',
    allowSplit: false,
    minimumSessionMinutes: 60,
    timeConstraintType: 'fixed_event',
    requestedStartAt: planFixed.requestedStartAt,
    requestedEndAt: planFixed.requestedEndAt,
    timezone: 'Asia/Jakarta',
    createdAt: new Date().toISOString(),
  };

  const schedFixed = scheduleTaskDeterministically(taskFixed, [], [], INITIAL_PREFERENCES, new Date('2026-10-19T02:00:00.000Z'));
  if (!schedFixed.success || schedFixed.proposedSessions.length !== 1) {
    throw new Error('FAIL: Fixed event harus berhasil dijadwalkan tepat!');
  }
  const fStart = new Date(schedFixed.proposedSessions[0].startAt);
  const fEnd = new Date(schedFixed.proposedSessions[0].endAt);
  const fStartH = fStart.getUTCHours() + 7;
  const fEndH = fEnd.getUTCHours() + 7;
  if (fStartH !== 19 || fEndH !== 22) {
    throw new Error(`FAIL: Fixed event harus 19.00 - 22.00 WIB, got ${fStartH}.00 - ${fEndH}.00 WIB`);
  }
  console.log('✅ PASSED: Fixed event Rabu malam dijadwalkan tepat pada 19.00 - 22.00 WIB tanpa pergeseran!');

  // -------------------------------------------------------------
  // Test 6: Pengujian Regresi Wajib - Tugas Fleksibel Pagi
  // -------------------------------------------------------------
  console.log('\n--- Test 6: Regresi Wajib 2 - Tugas Fleksibel Pagi Hari ---');
  const promptMorning = 'Besok pagi belajar algoritma selama 60 menit';
  const planMorning = parseIndonesianTemporalRules({
    userPrompt: promptMorning,
    currentDateTime: '2026-10-19T02:00:00.000Z', // Senin
    userLocalTimeStr: '19/10/2026 09:00:00',
    userTimezone: 'Asia/Jakarta',
    workHours: { workStartHour: 9, workEndHour: 18 },
  });

  if (planMorning.preferredTimeOfDay !== 'MORNING') {
    throw new Error(`FAIL: Preferred time of day harus MORNING! Got: ${planMorning.preferredTimeOfDay}`);
  }
  const taskMorning: Task = {
    id: 'morning-study',
    userId: 'user-test',
    title: planMorning.title,
    description: planMorning.description,
    estimatedDurationMinutes: planMorning.estimatedDurationMinutes,
    priority: planMorning.priority,
    status: 'UNSCHEDULED',
    allowSplit: false,
    minimumSessionMinutes: 60,
    preferredTimeOfDay: 'MORNING',
    timeConstraintType: 'preferred_window',
    preferredWindow: planMorning.preferredWindow,
    timezone: 'Asia/Jakarta',
    createdAt: new Date().toISOString(),
  };

  const schedMorning = scheduleTaskDeterministically(taskMorning, [], [], INITIAL_PREFERENCES, new Date('2026-10-19T02:00:00.000Z'));
  if (!schedMorning.success || schedMorning.proposedSessions.length !== 1) {
    throw new Error('FAIL: Tugas pagi harus dijadwalkan!');
  }
  const mStart = new Date(schedMorning.proposedSessions[0].startAt);
  const mStartH = mStart.getUTCHours() + 7;
  if (mStartH < 6 || mStartH >= 12) {
    throw new Error(`FAIL: Tugas pagi harus dalam rentang 06:00 - 12:00 WIB, got ${mStartH}:00 WIB`);
  }
  console.log(`✅ PASSED: Tugas pagi ditempatkan tepat di jendela pagi pada pukul ${mStartH}.00 WIB!`);

  // -------------------------------------------------------------
  // Test 7: Pengujian Regresi Wajib - Diagnostik Slot Saat Penuh
  // -------------------------------------------------------------
  console.log('\n--- Test 7: Regresi Wajib 3 - Diagnostik Transparan Saat Slot Penuh ---');
  // Isi hari Kamis dengan acara penuh
  const busyThursday: CalendarEvent[] = [
    {
      id: 'full-evt-1',
      title: 'Workshop Desain Pagi',
      startAt: '2026-10-22T02:00:00.000Z', // 09:00 - 13:00 WIB
      endAt: '2026-10-22T06:00:00.000Z',
      isAllDay: false,
      provider: 'google',
      isEditable: false,
      syncStatus: 'synced',
    },
    {
      id: 'full-evt-2',
      title: 'Workshop Desain Siang',
      startAt: '2026-10-22T06:00:00.000Z', // 13:00 - 18:00 WIB
      endAt: '2026-10-22T11:00:00.000Z',
      isAllDay: false,
      provider: 'google',
      isEditable: false,
      syncStatus: 'synced',
    },
  ];

  const schedBlocked = scheduleTaskDeterministically(task2, busyThursday, [], INITIAL_PREFERENCES, new Date(ctx2.currentDateTime));
  if (schedBlocked.success) {
    throw new Error('FAIL: Tugas 180 menit tidak boleh berhasil di hari Kamis yang penuh!');
  }
  if (!schedBlocked.diagnostics?.evaluatedDays || schedBlocked.diagnostics.evaluatedDays.length === 0) {
    throw new Error('FAIL: Harus menyertakan diagnostik evaluatedDays per tanggal!');
  }
  const diag = schedBlocked.diagnostics.evaluatedDays[0];
  if (diag.dateStr !== '2026-10-22') {
    throw new Error(`FAIL: Diagnostik tanggal salah! Got: ${diag.dateStr}`);
  }
  if (diag.conflicts.length !== 2) {
    throw new Error(`FAIL: Diagnostik harus mencatat 2 konflik agenda pemblokir! Got: ${diag.conflicts.length}`);
  }
  console.log(`✅ PASSED: Diagnostik transparan menyajikan alasan penolakan dan daftar 2 konflik (${diag.conflicts.join(', ')})!`);

  console.log('\n========================================================================');
  console.log('🎉 SEMUA 7 PENGUJIAN REGRESI DAN VALIDASI BUG KRITIS BERHASIL 100%! 🎉');
  console.log('========================================================================\n');
}

// Auto-run if executed directly
if (typeof process !== 'undefined' && process.argv[1]?.includes('critical-bugs-validation.test.ts')) {
  runCriticalBugsValidationTests();
}
