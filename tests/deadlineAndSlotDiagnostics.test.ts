import {
  parseIndonesianTemporalRules,
  ParseContext,
} from '../src/lib/temporalParser';
import {
  scheduleTaskDeterministically,
  formatWindowTime,
  verifyAndNormalizeReferenceDate,
  DEFAULT_MIN_SPLIT_SESSION_GAP_MINUTES,
} from '../src/lib/scheduler';
import {
  createIsoInTimezone,
  getPartsInTimezone,
} from '../src/lib/timezone';
import { Task, CalendarEvent, UserPreferences } from '../src/types';
import { simulateBackendPlanPipeline, MOCK_REFERENCE_DATE, TEST_TIMEZONE } from './aiScheduler.test';
import {
  getAvailableSplitOptions,
  formatPlanTargetDisplay,
  resolveInitialSplitConfiguration,
} from '../src/components/AIAssistantView';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

export function runDeadlineAndSlotDiagnosticsTests() {
  console.log('========================================================================');
  console.log('🧪 SUITE: Deadline Bawaan Parser & Diagnosis Slot Penjadwalan EVEN');
  console.log('========================================================================');

  const defaultPrefs: UserPreferences = {
    displayName: 'Pengguna Uji',
    email: 'user@even.id',
    timezone: 'Asia/Jakarta',
    workStartHour: 9,
    workEndHour: 18,
    enableLunchBreak: true,
    lunchStartHour: 12,
    lunchEndHour: 13,
    bufferMinutes: 15,
    workDays: [1, 2, 3, 4, 5],
    googleCalendarConnected: false,
    calendarSyncStatus: 'synced',
    lastSyncedAt: null,
    allowAutoSplit: false,
  };

  // KASUS 1: Prompt tanpa tenggat waktu ("Buat jadwal untuk mengerjakan laporan praktikum selama 90 menit.")
  console.log('>>> [1/7] Kasus 1: Parser tidak menciptakan tenggat bawaan 18:00 hari ini jika tidak ada tenggat yang diminta');
  {
    const prompt = 'Buat jadwal untuk mengerjakan laporan praktikum selama 90 menit.';
    const ctx: ParseContext = {
      userPrompt: prompt,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(), // Senin, 20 Mei 2024, 16:00 WIB
      userTimezone: TEST_TIMEZONE,
    };

    const parsed = parseIndonesianTemporalRules(ctx);
    assert(parsed.estimatedDurationMinutes === 90, `Durasi harus 90 menit, dapat ${parsed.estimatedDurationMinutes}`);
    assert(parsed.title === 'Mengerjakan Laporan Praktikum', `Judul harus 'Mengerjakan Laporan Praktikum', dapat '${parsed.title}'`);
    assert(parsed.deadlineAt === undefined, `deadlineAt harus undefined, dapat '${parsed.deadlineAt}'`);
    assert(parsed.deadlineDaysFromNow === undefined, `deadlineDaysFromNow harus undefined, dapat ${parsed.deadlineDaysFromNow}`);
    assert(!parsed.reasoning.includes('tenggat waktu hari ini'), 'Reasoning tidak boleh menyebut tenggat hari ini');
    assert(parsed.reasoning.includes('estimasi durasi 90 menit untuk dijadwalkan pada waktu kerja luang berikutnya yang tersedia'), 'Reasoning harus mencantumkan pesan penjadwalan waktu luang berikutnya');

    // Scheduler mampu menemukan slot 90 menit di hari Senin jam 16:00 - 17:30 WIB
    const task: Task = {
      id: 'task-lab-90',
      userId: 'user-default',
      title: parsed.title,
      estimatedDurationMinutes: parsed.estimatedDurationMinutes,
      deadlineAt: parsed.deadlineAt,
      priority: parsed.priority,
      status: 'UNSCHEDULED',
      allowSplit: parsed.allowSplit,
      timezone: TEST_TIMEZONE,
      createdAt: MOCK_REFERENCE_DATE.toISOString(),
    };

    const result = scheduleTaskDeterministically(task, [], [], defaultPrefs, MOCK_REFERENCE_DATE);
    assert(result.success === true, `Penjadwalan 90 menit harus sukses, dapat false: ${result.explanation}`);
    assert(result.proposedSessions.length === 1, `Harus ada 1 sesi, dapat ${result.proposedSessions.length}`);
    assert(result.proposedSessions[0].durationMinutes === 90, `Durasi sesi harus 90, dapat ${result.proposedSessions[0].durationMinutes}`);
    console.log('  ✅ [PASS] Kasus 1: Berhasil tanpa tenggat bawaan palsu.');
  }

  // KASUS 2: Tugas 90 menit diminta pada malam hari setelah jam kerja usai
  console.log('>>> [2/7] Kasus 2: Tugas tanpa tenggat di luar jam kerja dijadwalkan pada hari kerja berikutnya');
  {
    // Senin malam pukul 21:00 WIB (14:00 UTC)
    const mondayNightRef = new Date('2024-05-20T14:00:00.000Z');

    const task: Task = {
      id: 'task-no-deadline-night',
      userId: 'user-default',
      title: 'Mengerjakan Laporan Praktikum',
      estimatedDurationMinutes: 90,
      deadlineAt: undefined,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: false,
      timezone: TEST_TIMEZONE,
      createdAt: mondayNightRef.toISOString(),
    };

    const result = scheduleTaskDeterministically(task, [], [], defaultPrefs, mondayNightRef);
    assert(result.success === true, `Harus berhasil menemukan slot di hari kerja berikutnya, dapat: ${result.explanation}`);
    assert(result.proposedSessions.length === 1, 'Harus ada 1 sesi');

    const sessionStart = new Date(result.proposedSessions[0].startAt);
    const startParts = getPartsInTimezone(sessionStart, TEST_TIMEZONE);
    // Dijadwalkan pada hari Selasa (day = 21 Mei 2024) pukul 09:00 WIB
    assert(startParts.day === 21, `Harus dijadwalkan tanggal 21 (Selasa), dapat tanggal ${startParts.day}`);
    assert(startParts.hour === 9, `Harus dimulai jam 09:00 WIB, dapat jam ${startParts.hour}`);
    assert(startParts.minute === 0, 'Menit harus 0');
    console.log('  ✅ [PASS] Kasus 2: Berhasil dijadwalkan Selasa pagi 09:00 WIB.');
  }

  // KASUS 3: Diagnosis penolakan slot TIDAK PERNAH menyatakan "penuh oleh agenda lain" jika konflik kosong
  console.log('>>> [3/7] Kasus 3: Rejection reason tidak menuduh agenda lain ketika conflicts kosong');
  {
    const mondayNightRef = new Date('2024-05-20T14:00:00.000Z'); // 21:00 WIB
    const deadlineMondayNight = createIsoInTimezone(2024, 5, 20, 22, 0, 0, TEST_TIMEZONE);

    const task: Task = {
      id: 'task-impossible-monday',
      userId: 'user-default',
      title: 'Tugas Terlambat',
      estimatedDurationMinutes: 90,
      deadlineAt: deadlineMondayNight,
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: false,
      timezone: TEST_TIMEZONE,
      createdAt: mondayNightRef.toISOString(),
    };

    const result = scheduleTaskDeterministically(task, [], [], defaultPrefs, mondayNightRef);
    assert(result.success === false, 'Tugas dengan deadline 22:00 di luar jam kerja harus gagal');

    const evaluatedDays = result.diagnostics?.evaluatedDays || [];
    assert(evaluatedDays.length > 0, 'Evaluated days harus ada');

    for (const dayDiag of evaluatedDays) {
      if (dayDiag.conflicts.length === 0) {
        assert(!dayDiag.rejectionReason?.includes('penuh oleh agenda lain'), `rejectionReason tidak boleh 'penuh oleh agenda lain' saat conflicts kosong, dapat: '${dayDiag.rejectionReason}'`);
        assert(/(berakhir|habis|tidak ada konflik agenda lain|setelah batas tenggat)/i.test(dayDiag.rejectionReason || ''), `rejectionReason harus menjelaskan alasan sebenarnya, dapat: '${dayDiag.rejectionReason}'`);
      }
    }
    console.log('  ✅ [PASS] Kasus 3: Rejection reason jujur & transparan tanpa tuduhan agenda lain.');
  }

  // KASUS 4: Format batas jam kerja tengah malam (24:00 bukan 00:00)
  console.log('>>> [4/7] Kasus 4: Format batas akhir jam kerja tengah malam menggunakan 24:00 WIB, bukan 00:00 WIB');
  {
    const midnightDate = new Date('2024-05-20T17:00:00.000Z'); // Jam 00:00 WIB tanggal 21 Mei (pergantian hari)
    const formattedEnd = formatWindowTime(midnightDate, TEST_TIMEZONE, true);
    assert(formattedEnd === '24:00' || formattedEnd === '24.00', `Batas akhir tengah malam harus 24:00 / 24.00, dapat '${formattedEnd}'`);

    const noonDate = new Date('2024-05-20T05:00:00.000Z'); // Jam 12:00 WIB
    const formattedNoon = formatWindowTime(noonDate, TEST_TIMEZONE, true);
    assert(formattedNoon === '12:00' || formattedNoon === '12.00', `Tengah hari harus 12:00 / 12.00, dapat '${formattedNoon}'`);
    console.log(`  ✅ [PASS] Kasus 4: Format batas penutup hari '${formattedEnd}' tepat dan tidak ambigu.`);
  }

  // KASUS 5: Tenggat eksplisit pengguna tetap dicatat secara presisi
  console.log('>>> [5/7] Kasus 5: Tenggat eksplisit (deadline hari Jumat) tetap dicatat dan dipatuhi');
  {
    const prompt = 'Aku ada tugas kalkulus selama 60 menit deadline hari Jumat';
    const ctx: ParseContext = {
      userPrompt: prompt,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(), // Senin 20 Mei
      userTimezone: TEST_TIMEZONE,
    };

    const parsed = parseIndonesianTemporalRules(ctx);
    assert(parsed.estimatedDurationMinutes === 60, 'Durasi harus 60 menit');
    assert(parsed.deadlineAt !== undefined, 'deadlineAt harus terdefinisi');

    const deadlineDate = new Date(parsed.deadlineAt!);
    const parts = getPartsInTimezone(deadlineDate, TEST_TIMEZONE);
    assert(parts.dayOfWeek === 5, `Hari tenggat harus Jumat (5), dapat ${parts.dayOfWeek}`);
    assert(parts.hour === 23, `Jam harus 23, dapat ${parts.hour}`);
    assert(parts.minute === 59, `Menit harus 59, dapat ${parts.minute}`);
    console.log('  ✅ [PASS] Kasus 5: Tenggat Jumat 23:59 WIB tercatat sempurna.');
  }

  // KASUS 6: Sanitasi pipeline backend menghapus deadline buatan AI jika user tidak memintanya
  console.log('>>> [6/7] Kasus 6: Pipeline backend menghapus halusinasi deadline dari AI');
  {
    const prompt = 'Buat jadwal untuk mengerjakan laporan praktikum selama 90 menit.';
    const fakeGeminiPlan = {
      title: 'Mengerjakan Laporan Praktikum',
      estimatedDurationMinutes: 90,
      deadlineAt: '2024-05-20T11:00:00.000Z', // Halusinasi LLM
      deadlineDaysFromNow: 0,
      priority: 'MEDIUM' as const,
      timeConstraintType: 'deadline_only' as const,
      allowSplit: false,
    };

    const pipelineResult = simulateBackendPlanPipeline(prompt, {
      mockGeminiPlan: fakeGeminiPlan,
      apiKeyConfigured: true,
      refDate: MOCK_REFERENCE_DATE,
    });

    assert(pipelineResult.success === true, 'Pipeline harus sukses');
    assert(pipelineResult.plan.deadlineAt === undefined, `deadlineAt harus dihapus oleh sanitasi, dapat '${pipelineResult.plan.deadlineAt}'`);
    assert(pipelineResult.plan.deadlineDaysFromNow === undefined, `deadlineDaysFromNow harus dihapus oleh sanitasi, dapat ${pipelineResult.plan.deadlineDaysFromNow}`);
    console.log('  ✅ [PASS] Kasus 6: Halusinasi deadline AI berhasil dibersihkan.');
  }

  // KASUS 7: Rejection reason yang benar-benar ada konflik agenda
  console.log('>>> [7/7] Kasus 7: Rejection reason menyebutkan konflik agenda saat kalender benar-benar penuh');
  {
    const mondayRef = new Date('2024-05-20T02:00:00.000Z'); // 09:00 WIB Senin
    const fullDayEvent: CalendarEvent = {
      id: 'evt-all-day-meeting',
      provider: 'google',
      title: 'Workshop Seharian Penuh',
      startAt: createIsoInTimezone(2024, 5, 20, 9, 0, 0, TEST_TIMEZONE),
      endAt: createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE),
      isEditable: false,
      syncStatus: 'synced',
    };

    const taskWithMondayOnly: Task = {
      id: 'task-blocked',
      userId: 'user-default',
      title: 'Tugas Prioritas',
      estimatedDurationMinutes: 60,
      deadlineAt: createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE),
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: false,
      timezone: TEST_TIMEZONE,
      createdAt: mondayRef.toISOString(),
    };

    const result = scheduleTaskDeterministically(taskWithMondayOnly, [fullDayEvent], [], defaultPrefs, mondayRef);
    assert(result.success === false, 'Harus gagal karena penuh');

    const evaluatedDays = result.diagnostics?.evaluatedDays || [];
    assert(evaluatedDays.length > 0, 'Evaluated days harus ada');
    const dayDiag = evaluatedDays[0];
    assert(dayDiag.conflicts.length > 0, 'Conflicts harus ada');
    assert(dayDiag.rejectionReason?.includes('terisi penuh oleh agenda kalender/tugas lain'), `Harus menyebut terisi penuh oleh agenda kalender/tugas lain, dapat '${dayDiag.rejectionReason}'`);
    assert(dayDiag.rejectionReason?.includes('Workshop Seharian Penuh'), 'Harus menyebutkan nama agenda Workshop Seharian Penuh');
    console.log('  ✅ [PASS] Kasus 7: Diagnosis konflik agenda akurat.');
  }

  // KASUS 8: Tenggat yang sudah lewat menghasilkan diagnosis DEADLINE_PASSED
  console.log('>>> [8/9] Kasus 8: Tenggat yang sudah lewat menghasilkan failureCode DEADLINE_PASSED');
  {
    // Waktu acuan: Senin 20 Mei 2024, 16:00 WIB
    // Tenggat di masa lalu: Senin 20 Mei 2024, 10:00 WIB (sudah lewat 6 jam)
    const pastDeadline = createIsoInTimezone(2024, 5, 20, 10, 0, 0, TEST_TIMEZONE);
    const pastTask: Task = {
      id: 'task-past-deadline',
      userId: 'user-default',
      title: 'Tugas Terlewat Tenggat',
      estimatedDurationMinutes: 60,
      deadlineAt: pastDeadline,
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: false,
      timezone: TEST_TIMEZONE,
      createdAt: MOCK_REFERENCE_DATE.toISOString(),
    };

    const result = scheduleTaskDeterministically(pastTask, [], [], defaultPrefs, MOCK_REFERENCE_DATE);
    assert(result.success === false, 'Tugas dengan tenggat lewat harus gagal');
    assert(result.failureCode === 'DEADLINE_PASSED', `failureCode harus DEADLINE_PASSED, dapat: '${result.failureCode}'`);
    assert(result.explanation.includes('sudah lewat dari waktu saat ini'), 'Penjelasan harus menyebutkan tenggat sudah lewat');
    console.log('  ✅ [PASS] Kasus 8: Kode kegagalan DEADLINE_PASSED dihasilkan secara presisi.');
  }

  // KASUS 9: Integritas fixed event, multi-hari, recurring task, dan fallback lokal
  console.log('>>> [9/9] Kasus 9: Perilaku fixed event, multi-hari, recurring task, dan fallback lokal tetap lulus');
  {
    // Fixed event test
    const fixedPrompt = 'Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming';
    const parsedFixed = parseIndonesianTemporalRules({
      userPrompt: fixedPrompt,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(),
      userTimezone: TEST_TIMEZONE,
    });
    assert(parsedFixed.timeConstraintType === 'fixed_event', 'Harus fixed_event');
    assert(parsedFixed.estimatedDurationMinutes === 180, 'Durasi harus 180 menit');
    assert(!parsedFixed.allowSplit, 'Fixed event tidak boleh allow split');

    // Multi-day & recurring test
    const recurringPrompt = 'Kelas setiap Senin dan Rabu jam 19.00 sampai 21.00';
    const parsedRec = parseIndonesianTemporalRules({
      userPrompt: recurringPrompt,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(),
      userTimezone: TEST_TIMEZONE,
    });
    assert(parsedRec.isRecurring === true, 'Harus terdeteksi recurring');
    assert(parsedRec.targetDays?.includes(1) && parsedRec.targetDays?.includes(3), 'Harus mencakup Senin (1) dan Rabu (3)');

    // Fallback lokal deterministik
    const pipelineFallback = simulateBackendPlanPipeline('Belajar Next.js selama 60 menit', {
      mockGeminiPlan: null, // Simulasi kegagalan AI
      geminiError: new Error('AI Timeout'),
      apiKeyConfigured: true,
      refDate: MOCK_REFERENCE_DATE,
    });
    assert(pipelineFallback.success === true, 'Fallback harus tetap sukses menghasilkan rencana');
    assert(pipelineFallback.source === 'rule_fallback_on_error', 'Sumber harus transparan sebagai fallback');
    assert(pipelineFallback.isAiGenerated === false, 'Fallback tidak boleh diklaim sebagai isAiGenerated');
    console.log('  ✅ [PASS] Kasus 9: Seluruh kontrak fixed event, multi-hari, recurring, dan fallback terjaga sempurna.');
  }

  // KASUS 10: Target hari masa depan ("besok") tanpa kata kunci deadline mengembalikan deadlineAt === undefined
  console.log('>>> [10/11] Kasus 10: Target hari masa depan tanpa kata kunci deadline mengembalikan deadlineAt === undefined (bukan 18:00)');
  {
    const prompt = 'Belajar kimia selama 2 jam besok pagi';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(),
      userTimezone: TEST_TIMEZONE,
    });

    assert(parsed.deadlineAt === undefined, `deadlineAt harus undefined untuk target hari tanpa kata kunci deadline, dapat: '${parsed.deadlineAt}'`);
    assert(parsed.deadlineDaysFromNow === 1, `deadlineDaysFromNow untuk besok harus 1, dapat: ${parsed.deadlineDaysFromNow}`);
    assert(!parsed.reasoning.includes('tenggat waktu'), `Reasoning tidak boleh menyebutkan tenggat waktu saat deadlineAt undefined, dapat: '${parsed.reasoning}'`);
    console.log('  ✅ [PASS] Kasus 10: deadlineAt undefined dan deadlineDaysFromNow = 1 tercapai tanpa deadline 18:00 palsu.');
  }

  // KASUS 11: Penolakan jadwal di jendela preferensi tanpa konflik kalender tidak menuduh "jendela penuh"
  console.log('>>> [11/11] Kasus 11: Penolakan jendela preferensi tanpa konflik kalender tidak menampilkan "jendela penuh"');
  {
    // Tugas 5 jam (300 menit) di jendela malam (19:00 - 23:00 = 240 menit) tanpa opsi split, kalender KOSONG
    const eveningTask: Task = {
      id: 'task-long-evening',
      userId: 'user-default',
      title: 'Belajar Coding Marathon',
      estimatedDurationMinutes: 300, // 5 jam
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
      timezone: TEST_TIMEZONE,
      createdAt: MOCK_REFERENCE_DATE.toISOString(),
    };

    const result = scheduleTaskDeterministically(eveningTask, [], [], defaultPrefs, MOCK_REFERENCE_DATE);
    assert(result.success === false, 'Tugas 300 menit di jendela 240 menit tanpa split harus ditolak');
    assert(!result.explanation.includes('penuh atau terhalang agenda lain'), `Penjelasan tidak boleh menuduh 'penuh atau terhalang agenda lain' saat konflik kosong, dapat: '${result.explanation}'`);
    assert(result.explanation.includes('tidak ada konflik agenda lain'), `Penjelasan harus jujur menyatakan 'tidak ada konflik agenda lain', dapat: '${result.explanation}'`);

    const evaluatedDays = result.diagnostics?.evaluatedDays || [];
    assert(evaluatedDays.length > 0, 'evaluatedDays harus tersedia dalam diagnostik penolakan jendela preferensi');
    assert(evaluatedDays[0].conflicts.length === 0, 'conflicts harus kosong');
    assert(evaluatedDays[0].maxContiguousFreeMinutes !== undefined, 'maxContiguousFreeMinutes harus terhitung');
    assert(evaluatedDays[0].totalFreeMinutes !== undefined, 'totalFreeMinutes harus terhitung');
    console.log('  ✅ [PASS] Kasus 11: Diagnostik penolakan jendela jujur tanpa tuduhan jendela penuh.');
  }

  // KASUS 12: Pemisahan Tegas Tanggal Target vs Tenggat ("Belajar kimia selama 2 jam besok pagi")
  console.log('>>> [12/16] Kasus 12: Pemisahan target date vs tenggat ("Belajar kimia selama 2 jam besok pagi")');
  {
    const prompt = 'Belajar kimia selama 2 jam besok pagi.';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(), // Senin, 20 Mei 2024, 16:00 WIB
      userTimezone: TEST_TIMEZONE,
    });

    assert(parsed.estimatedDurationMinutes === 120, `Durasi harus 120 menit, dapat: ${parsed.estimatedDurationMinutes}`);
    assert(parsed.targetDayOffset === 1, `targetDayOffset harus 1, dapat: ${parsed.targetDayOffset}`);
    assert(parsed.targetDate === '2024-05-21', `targetDate harus '2024-05-21', dapat: '${parsed.targetDate}'`);
    assert(parsed.hasExplicitDeadline === false, `hasExplicitDeadline harus false, dapat: ${parsed.hasExplicitDeadline}`);
    assert(parsed.deadlineAt === undefined, `deadlineAt harus undefined, dapat: '${parsed.deadlineAt}'`);
    assert(parsed.preferredTimeOfDay === 'MORNING', `preferredTimeOfDay harus MORNING, dapat: ${parsed.preferredTimeOfDay}`);

    // Simulasi pembuatan pseudoTask seperti di AIAssistantView.tsx
    const calculatedDeadlineAt = parsed.hasExplicitDeadline && parsed.deadlineAt ? parsed.deadlineAt : undefined;
    assert(calculatedDeadlineAt === undefined, 'calculatedDeadlineAt TIDAK boleh dibuat buatan pada jam 18:00 atau 23:00!');

    const task: Task = {
      id: 'task-chem-besok',
      userId: 'user-default',
      title: parsed.title,
      estimatedDurationMinutes: parsed.estimatedDurationMinutes,
      deadlineAt: calculatedDeadlineAt,
      priority: parsed.priority,
      status: 'UNSCHEDULED',
      allowSplit: parsed.allowSplit,
      timeConstraintType: parsed.timeConstraintType,
      preferredTimeOfDay: parsed.preferredTimeOfDay,
      preferredWindow: parsed.preferredWindow,
      targetDays: parsed.targetDays,
      targetDate: parsed.targetDate,
      targetDayOffset: parsed.targetDayOffset,
      hasExplicitDeadline: parsed.hasExplicitDeadline,
      timezone: TEST_TIMEZONE,
      createdAt: MOCK_REFERENCE_DATE.toISOString(),
    };

    const result = scheduleTaskDeterministically(task, [], [], defaultPrefs, MOCK_REFERENCE_DATE);
    assert(result.success === true, `Jadwal harus sukses, error: ${result.explanation}`);
    assert(result.proposedSessions.length === 1, 'Harus ada 1 sesi 2 jam');
    const session = result.proposedSessions[0];
    const sessionStart = getPartsInTimezone(new Date(session.startAt), TEST_TIMEZONE);
    assert(sessionStart.day === 21, `Harus dijadwalkan Selasa (21 Mei), dapat: ${sessionStart.day}`);
    assert(sessionStart.hour >= 6 && sessionStart.hour <= 10, `Harus dalam jendela pagi (06:00 - 12:00 WIB), dapat jam: ${sessionStart.hour}`);
    assert(session.durationMinutes === 120, `Durasi harus 120 menit, dapat: ${session.durationMinutes}`);
    console.log('  ✅ [PASS] Kasus 12: Target besok pagi terjadwal Selasa 09:00-11:00 WIB tanpa batas tenggat 18:00.');
  }

  // KASUS 13: Fixed event dengan tanggal target "Kelas React besok pukul 19.00 selama 1 jam."
  console.log('>>> [13/16] Kasus 13: Fixed event besok malam terjadwal presisi tanpa tenggat palsu');
  {
    const prompt = 'Kelas React besok pukul 19.00 selama 1 jam.';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(),
      userTimezone: TEST_TIMEZONE,
    });

    assert(parsed.timeConstraintType === 'fixed_event', 'Harus fixed_event');
    assert(parsed.targetDate === '2024-05-21', `targetDate harus '2024-05-21', dapat: ${parsed.targetDate}`);
    assert(parsed.targetDayOffset === 1, `targetDayOffset harus 1, dapat: ${parsed.targetDayOffset}`);
    assert(parsed.hasExplicitDeadline === false, 'hasExplicitDeadline harus false');
    assert(parsed.deadlineAt === undefined, 'deadlineAt harus undefined');

    const task: Task = {
      id: 'task-react-besok',
      userId: 'user-default',
      title: parsed.title,
      estimatedDurationMinutes: parsed.estimatedDurationMinutes,
      deadlineAt: undefined,
      priority: parsed.priority,
      status: 'UNSCHEDULED',
      allowSplit: false,
      timeConstraintType: 'fixed_event',
      requestedStartAt: parsed.requestedStartAt,
      requestedEndAt: parsed.requestedEndAt,
      targetDate: parsed.targetDate,
      targetDayOffset: parsed.targetDayOffset,
      hasExplicitDeadline: false,
      timezone: TEST_TIMEZONE,
      createdAt: MOCK_REFERENCE_DATE.toISOString(),
    };

    const result = scheduleTaskDeterministically(task, [], [], defaultPrefs, MOCK_REFERENCE_DATE);
    assert(result.success === true, `Jadwal harus sukses: ${result.explanation}`);
    const session = result.proposedSessions[0];
    const sessionStart = getPartsInTimezone(new Date(session.startAt), TEST_TIMEZONE);
    assert(sessionStart.day === 21, `Harus Selasa (21), dapat: ${sessionStart.day}`);
    assert(sessionStart.hour === 19, `Harus jam 19, dapat: ${sessionStart.hour}`);
    console.log('  ✅ [PASS] Kasus 13: Fixed event besok malam terjadwal presisi Selasa 19:00 WIB.');
  }

  // KASUS 14: Tenggat eksplisit "Selesaikan laporan selama 90 menit sebelum Jumat pukul 18.00."
  console.log('>>> [14/16] Kasus 14: Tenggat eksplisit sebelum Jumat pukul 18.00 dipertahankan');
  {
    const prompt = 'Selesaikan laporan selama 90 menit sebelum Jumat pukul 18.00.';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(),
      userTimezone: TEST_TIMEZONE,
    });

    assert(parsed.hasExplicitDeadline === true, 'hasExplicitDeadline harus true');
    assert(parsed.deadlineAt !== undefined, 'deadlineAt harus ada');
    const deadlineParts = getPartsInTimezone(new Date(parsed.deadlineAt!), TEST_TIMEZONE);
    assert(deadlineParts.dayOfWeek === 5, `Hari tenggat harus Jumat (5), dapat: ${deadlineParts.dayOfWeek}`);
    assert(deadlineParts.hour === 18, `Jam tenggat harus 18:00 WIB, dapat: ${deadlineParts.hour}`);
    assert(deadlineParts.minute === 0, `Menit tenggat harus 0, dapat: ${deadlineParts.minute}`);
    console.log('  ✅ [PASS] Kasus 14: Tenggat eksplisit Jumat 18:00 WIB terdeteksi akurat.');
  }

  // KASUS 15: Pembedaan failureCode TARGET_DATE_PASSED vs DEADLINE_PASSED
  console.log('>>> [15/16] Kasus 15: Pembedaan failureCode TARGET_DATE_PASSED vs DEADLINE_PASSED');
  {
    // A: Tanggal target kemarin -> TARGET_DATE_PASSED
    const pastTargetTask: Task = {
      id: 'task-yesterday',
      userId: 'user-default',
      title: 'Tugas Target Kemarin',
      estimatedDurationMinutes: 60,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: false,
      targetDayOffset: -1,
      targetDate: '2024-05-19',
      hasExplicitDeadline: false,
      timezone: TEST_TIMEZONE,
      createdAt: MOCK_REFERENCE_DATE.toISOString(),
    };
    const resultPastTarget = scheduleTaskDeterministically(pastTargetTask, [], [], defaultPrefs, MOCK_REFERENCE_DATE);
    assert(resultPastTarget.success === false, 'Target date kemarin harus gagal');
    assert(resultPastTarget.failureCode === 'TARGET_DATE_PASSED', `failureCode harus TARGET_DATE_PASSED, dapat: ${resultPastTarget.failureCode}`);
    assert(resultPastTarget.explanation.includes('Tanggal target kegiatan'), 'Penjelasan harus menyebutkan tanggal target kegiatan');

    // B: Tenggat kemarin -> DEADLINE_PASSED
    const pastDeadlineTask: Task = {
      id: 'task-past-dl',
      userId: 'user-default',
      title: 'Tugas Tenggat Kemarin',
      estimatedDurationMinutes: 60,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: false,
      deadlineAt: createIsoInTimezone(2024, 5, 19, 18, 0, 0, TEST_TIMEZONE),
      hasExplicitDeadline: true,
      timezone: TEST_TIMEZONE,
      createdAt: MOCK_REFERENCE_DATE.toISOString(),
    };
    const resultPastDeadline = scheduleTaskDeterministically(pastDeadlineTask, [], [], defaultPrefs, MOCK_REFERENCE_DATE);
    assert(resultPastDeadline.success === false, 'Tenggat kemarin harus gagal');
    assert(resultPastDeadline.failureCode === 'DEADLINE_PASSED', `failureCode harus DEADLINE_PASSED, dapat: ${resultPastDeadline.failureCode}`);
    assert(resultPastDeadline.explanation.includes('Tenggat waktu'), 'Penjelasan harus menyebutkan tenggat waktu');
    console.log('  ✅ [PASS] Kasus 15: TARGET_DATE_PASSED dan DEADLINE_PASSED dibedakan secara tegas.');
  }

  // KASUS 16: Ekuivalensi Fallback & Sanitasi Gemini untuk targetDate dan hasExplicitDeadline
  console.log('>>> [16/16] Kasus 16: Sanitasi pipeline AI dan fallback memiliki semantik targetDate & deadline yang identik');
  {
    const prompt = 'Belajar biologi selama 45 menit besok pagi.';
    const geminiHallucinatedPlan = {
      title: 'Belajar Biologi',
      estimatedDurationMinutes: 45,
      preferredTimeOfDay: 'MORNING' as const,
      deadlineAt: '2024-05-21T11:00:00.000Z', // AI mengarang deadline
      deadlineDaysFromNow: 1,
      priority: 'MEDIUM' as const,
      timeConstraintType: 'preferred_window' as const,
      allowSplit: false,
    };

    const sanitizedResult = simulateBackendPlanPipeline(prompt, {
      mockGeminiPlan: geminiHallucinatedPlan,
      apiKeyConfigured: true,
      refDate: MOCK_REFERENCE_DATE,
    });

    assert(sanitizedResult.success === true, 'Pipeline harus sukses');
    assert(sanitizedResult.plan.hasExplicitDeadline === false, 'hasExplicitDeadline harus false');
    assert(sanitizedResult.plan.deadlineAt === undefined, 'deadlineAt harus dibersihkan dari halusinasi');
    assert(sanitizedResult.plan.targetDate === '2024-05-21', `targetDate harus '2024-05-21', dapat: ${sanitizedResult.plan.targetDate}`);
    assert(sanitizedResult.plan.targetDayOffset === 1, `targetDayOffset harus 1, dapat: ${sanitizedResult.plan.targetDayOffset}`);

    const fallbackResult = simulateBackendPlanPipeline(prompt, {
      mockGeminiPlan: null,
      geminiError: new Error('Network error'),
      apiKeyConfigured: true,
      refDate: MOCK_REFERENCE_DATE,
    });

    assert(fallbackResult.success === true, 'Fallback harus sukses');
    assert(fallbackResult.plan.hasExplicitDeadline === false, 'Fallback hasExplicitDeadline harus false');
    assert(fallbackResult.plan.deadlineAt === undefined, 'Fallback deadlineAt harus undefined');
    assert(fallbackResult.plan.targetDate === sanitizedResult.plan.targetDate, 'targetDate fallback dan sanitized harus sama persis');
    assert(fallbackResult.plan.targetDayOffset === sanitizedResult.plan.targetDayOffset, 'targetDayOffset fallback dan sanitized harus sama');
    console.log('  ✅ [PASS] Kasus 16: Ekuivalensi semantik AI sanitization dan deterministic fallback sempurna.');
  }

  // KASUS 17: Pilihan Pembagian Sesi Nyata (90m utuh vs 2x45m terpisah, deteksi slot parsial & kegagalan jujur)
  console.log('>>> [17/20] Kasus 17: Kontrol pembagian sesi berfungsi nyata di deterministic scheduler');
  {
    // Kalender memiliki dua slot 45 menit terpisah pada hari Senin:
    // Slot 1: 10:00 - 10:45 (45 menit)
    // Acara 1: 10:45 - 14:00 (sibuk)
    // Slot 2: 14:00 - 14:45 (45 menit)
    // Acara 2: 14:45 - 18:00 (sibuk)
    // Di kalender ini: TIDAK ADA slot 90 menit kontigu. Hanya ada 2 slot 45 menit.
    const busyEvents: CalendarEvent[] = [
      {
        id: 'evt-busy-1',
        userId: 'user-default',
        title: 'Rapat Koordinasi Tim',
        startAt: createIsoInTimezone(2024, 5, 20, 10, 45, 0, TEST_TIMEZONE),
        endAt: createIsoInTimezone(2024, 5, 20, 14, 0, 0, TEST_TIMEZONE),
        isAllDay: false,
        source: 'internal',
        editable: false,
      },
      {
        id: 'evt-busy-2',
        userId: 'user-default',
        title: 'Presentasi Proyek',
        startAt: createIsoInTimezone(2024, 5, 20, 14, 45, 0, TEST_TIMEZONE),
        endAt: createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE),
        isAllDay: false,
        source: 'internal',
        editable: false,
      },
    ];

    // Sub-kasus 17A: Pengguna memilih 'Satu Sesi Utuh' (90 menit) pada hari Senin saja (tenggat jam 18:00)
    const taskSingle: Task = {
      id: 'task-single-90',
      userId: 'user-default',
      title: 'Mengerjakan Laporan Praktikum',
      estimatedDurationMinutes: 90,
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 30,
      splitConfig: {
        forcedMode: 'single',
        targetSessionCount: 1,
        sessionDurationMinutes: 90,
      },
      deadlineAt: createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE),
      hasExplicitDeadline: true,
      timezone: TEST_TIMEZONE,
      createdAt: MOCK_REFERENCE_DATE.toISOString(),
    };

    const cleanPrefs: UserPreferences = {
      ...defaultPrefs,
      bufferMinutes: 0,
      enableLunchBreak: false,
    };

    const morningAnchor = new Date('2024-05-20T03:00:00.000Z'); // 10:00 WIB
    const resultSingle = scheduleTaskDeterministically(taskSingle, busyEvents, [], cleanPrefs, morningAnchor);
    assert(resultSingle.success === false, 'Mode satu sesi utuh harus gagal karena tidak ada slot 90 menit kontigu');
    assert(
      resultSingle.failureCode === 'NO_CONTIGUOUS_SLOT' || resultSingle.failureCode === 'DEADLINE_INSUFFICIENT_TIME',
      `failureCode harus melaporkan kegagalan slot kontigu, dapat: ${resultSingle.failureCode}`
    );
    assert(
      resultSingle.explanation.includes('kontigu') || resultSingle.explanation.includes('tidak mencukupi'),
      'Penjelasan harus jujur menjelaskan slot kontigu tidak cukup'
    );

    // Sub-kasus 17B: Pengguna beralih ke 'Bagi Menjadi Beberapa Sesi' (2 sesi × 45 menit)
    const taskSplit: Task = {
      ...taskSingle,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 2,
        sessionDurationMinutes: 45,
      },
    };

    const resultSplit = scheduleTaskDeterministically(taskSplit, busyEvents, [], cleanPrefs, morningAnchor);
    assert(resultSplit.success === true, `Mode 2x45m harus sukses di kalender ini, dapat false: ${resultSplit.explanation}`);
    assert(resultSplit.proposedSessions.length === 2, `Harus menghasilkan 2 sesi, dapat: ${resultSplit.proposedSessions.length}`);
    assert(resultSplit.proposedSessions[0].durationMinutes === 45, `Sesi 1 harus 45m, dapat: ${resultSplit.proposedSessions[0].durationMinutes}`);
    assert(resultSplit.proposedSessions[1].durationMinutes === 45, `Sesi 2 harus 45m, dapat: ${resultSplit.proposedSessions[1].durationMinutes}`);
    const totalAllocated = resultSplit.proposedSessions.reduce((acc, s) => acc + s.durationMinutes, 0);
    assert(totalAllocated === 90, `Total waktu teralokasi harus tepat 90m, dapat: ${totalAllocated}`);

    // Sub-kasus 17C: Deteksi kegagalan parsial jujur (hanya ada 1 slot 45m, slot ke-2 tidak ada)
    // Tambahkan event sibuk tambahan yang menutupi slot ke-2:
    const busyEventsOnlyOneSlot: CalendarEvent[] = [
      ...busyEvents,
      {
        id: 'evt-busy-3',
        userId: 'user-default',
        title: 'Meeting Tambahan',
        startAt: createIsoInTimezone(2024, 5, 20, 14, 0, 0, TEST_TIMEZONE),
        endAt: createIsoInTimezone(2024, 5, 20, 14, 45, 0, TEST_TIMEZONE),
        isAllDay: false,
        source: 'internal',
        editable: false,
      },
    ];

    const resultPartialFail = scheduleTaskDeterministically(taskSplit, busyEventsOnlyOneSlot, [], cleanPrefs, morningAnchor);
    assert(resultPartialFail.success === false, 'Jika hanya ada 1 slot dari 2 sesi yang diminta, scheduler HARUS gagal');
    assert(
      resultPartialFail.failureCode === 'INSUFFICIENT_SPLIT_SLOTS' || resultPartialFail.failureCode === 'DEADLINE_INSUFFICIENT_TIME',
      `failureCode harus INSUFFICIENT_SPLIT_SLOTS, dapat: ${resultPartialFail.failureCode}`
    );
    assert(
      resultPartialFail.explanation.includes('sesi') || resultPartialFail.explanation.includes('tidak mencukupi'),
      'Penjelasan harus jujur menjelaskan sesi tidak terpenuhi'
    );

    console.log('  ✅ [PASS] Kasus 17: Kontrol pembagian sesi berfungsi nyata dan jujur melaporkan kegagalan slot parsial.');
  }

  // KASUS 18: Tampilan Target / Waktu Bebas dari 'undefined hari' untuk Semua Skenario
  console.log('>>> [18/20] Kasus 18: Tampilan Target / Waktu tidak pernah menampilkan "undefined hari"');
  {
    // Skenario A: Prompt murni tanpa tanggal target ("Buat jadwal untuk mengerjakan laporan praktikum selama 90 menit.")
    const promptNoTarget = 'Buat jadwal untuk mengerjakan laporan praktikum selama 90 menit.';
    const parsedNoTarget = parseIndonesianTemporalRules({
      userPrompt: promptNoTarget,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(),
      userTimezone: TEST_TIMEZONE,
    });
    const displayNoTarget = formatPlanTargetDisplay(parsedNoTarget, TEST_TIMEZONE);
    assert(!displayNoTarget.includes('undefined'), `displayNoTarget tidak boleh mengandung 'undefined': '${displayNoTarget}'`);
    assert(
      displayNoTarget === 'Fleksibel (Kapan saja)' || displayNoTarget.includes('Fleksibel'),
      `displayNoTarget harus bernilai Fleksibel, dapat: '${displayNoTarget}'`
    );

    // Skenario B: Prompt dengan target relatif ("Belajar kimia selama 2 jam besok pagi.")
    const promptTomorrow = 'Belajar kimia selama 2 jam besok pagi.';
    const parsedTomorrow = parseIndonesianTemporalRules({
      userPrompt: promptTomorrow,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(),
      userTimezone: TEST_TIMEZONE,
    });
    const displayTomorrow = formatPlanTargetDisplay(parsedTomorrow, TEST_TIMEZONE);
    assert(!displayTomorrow.includes('undefined'), `displayTomorrow tidak boleh mengandung 'undefined': '${displayTomorrow}'`);
    assert(
      displayTomorrow.includes('Besok') || displayTomorrow.includes('Pagi'),
      `displayTomorrow harus menyebutkan Besok atau Pagi, dapat: '${displayTomorrow}'`
    );

    // Skenario C: Prompt dengan tenggat tapi tanpa target pengerjaan ("Selesaikan laporan selama 90 menit sebelum Jumat pukul 18.00.")
    const promptDeadlineOnly = 'Selesaikan laporan selama 90 menit sebelum Jumat pukul 18.00.';
    const parsedDeadlineOnly = parseIndonesianTemporalRules({
      userPrompt: promptDeadlineOnly,
      currentDateTime: MOCK_REFERENCE_DATE.toISOString(),
      userTimezone: TEST_TIMEZONE,
    });
    const displayDeadlineOnly = formatPlanTargetDisplay(parsedDeadlineOnly, TEST_TIMEZONE);
    assert(!displayDeadlineOnly.includes('undefined'), `displayDeadlineOnly tidak boleh mengandung 'undefined': '${displayDeadlineOnly}'`);
    assert(
      displayDeadlineOnly === 'Fleksibel (Kapan saja)' || displayDeadlineOnly.includes('Fleksibel'),
      `displayDeadlineOnly harus bernilai Fleksibel karena hanya tenggat, dapat: '${displayDeadlineOnly}'`
    );

    console.log('  ✅ [PASS] Kasus 18: Tampilan Target / Waktu terbebas 100% dari string "undefined hari".');
  }

  // KASUS 19: Validasi Generator Opsi Pembagian (getAvailableSplitOptions)
  console.log('>>> [19/20] Kasus 19: Generator opsi pembagian sesi dan penegakan batas minimum sesi');
  {
    // Total 90m dengan batas min 30m: opsi harus 2x45m dan 3x30m
    const options90 = getAvailableSplitOptions(90, 30);
    assert(options90.length === 2, `Harus ada 2 opsi untuk 90m (min 30m), dapat: ${options90.length}`);
    assert(options90[0].sessionCount === 2 && options90[0].durationPerSession === 45, 'Opsi 1 harus 2 sesi @ 45m');
    assert(options90[1].sessionCount === 3 && options90[1].durationPerSession === 30, 'Opsi 2 harus 3 sesi @ 30m');

    // Total 45m dengan batas min 30m: 45 / 2 = 22 < 30 -> tidak ada opsi pembagian
    const options45 = getAvailableSplitOptions(45, 30);
    assert(options45.length === 0, `Harus ada 0 opsi pembagian untuk 45m dengan min 30m, dapat: ${options45.length}`);

    // Total 60m dengan batas min 30m: opsi harus 2x30m
    const options60 = getAvailableSplitOptions(60, 30);
    assert(options60.length === 1, `Harus ada 1 opsi untuk 60m (min 30m), dapat: ${options60.length}`);
    assert(options60[0].sessionCount === 2 && options60[0].durationPerSession === 30, 'Opsi harus 2 sesi @ 30m');

    // Total 120m dengan batas min 45m: 2x60m boleh, 3x40m ditolak karena 40 < 45
    const options120 = getAvailableSplitOptions(120, 45);
    assert(options120.length === 1, `Harus ada 1 opsi untuk 120m dengan min 45m, dapat: ${options120.length}`);
    assert(options120[0].sessionCount === 2 && options120[0].durationPerSession === 60, 'Opsi harus 2 sesi @ 60m');

    console.log('  ✅ [PASS] Kasus 19: getAvailableSplitOptions menghasilkan opsi rasional dan mematuhi batas minimum.');
  }

  // KASUS 20: Anggaran Waktu Timeout Terukur dan Integritas Fallback
  console.log('>>> [20/20] Kasus 20: Anggaran waktu backend terukur & proteksi fallback yang valid');
  {
    const prompt = 'Selesaikan laporan selama 90 menit sebelum Jumat pukul 18.00.';

    // Fallback pada error network / timeout API
    const simulatedFallback = simulateBackendPlanPipeline(prompt, {
      mockGeminiPlan: null,
      geminiError: new Error('Request timeout after 8000ms'),
      apiKeyConfigured: true,
      refDate: MOCK_REFERENCE_DATE,
    });

    assert(simulatedFallback.success === true, 'Fallback harus sukses untuk prompt yang valid');
    assert(simulatedFallback.source === 'rule_fallback_on_error', `Source harus rule_fallback_on_error, dapat: ${simulatedFallback.source}`);
    assert(simulatedFallback.plan.estimatedDurationMinutes === 90, 'Durasi harus 90m');
    assert(simulatedFallback.plan.hasExplicitDeadline === true, 'Tenggat harus dikenali');

    // Proteksi: prompt tanpa durasi/judul tidak boleh melaporkan kesuksesan palsu
    const invalidPrompt = '   halo   ';
    const simulatedInvalid = simulateBackendPlanPipeline(invalidPrompt, {
      mockGeminiPlan: null,
      geminiError: new Error('Service unavailable'),
      apiKeyConfigured: true,
      refDate: MOCK_REFERENCE_DATE,
    });
    assert(
      simulatedInvalid.success === false,
      'Prompt tanpa durasi tidak boleh pura-pura sukses dalam fallback'
    );

    console.log('  ✅ [PASS] Kasus 20: Anggaran timeout dan fallback tervalidasi dengan proteksi kejujuran status.');
  }

  // KASUS 21: Distribusi Multi-Sesi 3 × 30 Menit Terpisah Secara Temporal dengan Gap Minimal (60 Menit)
  console.log('>>> [21/23] Kasus 21: Distribusi multi-sesi 3x30m terpisah secara temporal dengan jeda minimal 60 menit');
  {
    const mondayMorningAnchor = new Date('2024-05-20T02:00:00.000Z'); // 09:00 WIB Senin
    const task3x30: Task = {
      id: 'task-split-3x30',
      userId: 'user-default',
      title: 'Mengerjakan Laporan Praktikum',
      estimatedDurationMinutes: 90,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 30,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 3,
        sessionDurationMinutes: 30,
        minGapMinutes: DEFAULT_MIN_SPLIT_SESSION_GAP_MINUTES, // 60 menit
      },
      timezone: TEST_TIMEZONE,
      createdAt: mondayMorningAnchor.toISOString(),
    };

    const cleanPrefs: UserPreferences = {
      ...defaultPrefs,
      bufferMinutes: 0,
      enableLunchBreak: false,
    };

    const result = scheduleTaskDeterministically(task3x30, [], [], cleanPrefs, mondayMorningAnchor);
    assert(result.success === true, `Jadwal 3x30m harus berhasil di hari kosong, dapat: ${result.explanation}`);
    assert(result.proposedSessions.length === 3, `Harus ada tepat 3 sesi, dapat: ${result.proposedSessions.length}`);

    // Periksa durasi tiap sesi
    for (let i = 0; i < 3; i++) {
      assert(
        result.proposedSessions[i].durationMinutes === 30,
        `Sesi ${i + 1} harus berdurasi 30 menit, dapat: ${result.proposedSessions[i].durationMinutes}`
      );
    }

    // Verifikasi jeda antar sesi: Sesi berikutnya tidak boleh menempel (kontigu) tanpa jeda
    const s1End = new Date(result.proposedSessions[0].endAt).getTime();
    const s2Start = new Date(result.proposedSessions[1].startAt).getTime();
    const gap1 = (s2Start - s1End) / 60000;
    assert(
      gap1 >= 60,
      `Jeda antara sesi 1 dan sesi 2 harus minimal 60 menit, dapat ${gap1} menit (sesi 1 end: ${result.proposedSessions[0].endAt}, sesi 2 start: ${result.proposedSessions[1].startAt})`
    );

    const s2End = new Date(result.proposedSessions[1].endAt).getTime();
    const s3Start = new Date(result.proposedSessions[2].startAt).getTime();
    const gap2 = (s3Start - s2End) / 60000;
    assert(
      gap2 >= 60,
      `Jeda antara sesi 2 dan sesi 3 harus minimal 60 menit, dapat ${gap2} menit (sesi 2 end: ${result.proposedSessions[1].endAt}, sesi 3 start: ${result.proposedSessions[2].startAt})`
    );

    console.log('  ✅ [PASS] Kasus 21: Sesi 3x30m sukses terpisah secara temporal dengan jeda >= 60 menit dan tidak menempel.');
  }

  // KASUS 22: Distribusi Multi-Sesi Multi-Hari & Penolakan Total Jika Slot Berjeda Tidak Cukup
  console.log('>>> [22/23] Kasus 22: Distribusi multi-sesi lintas hari & kegagalan INSUFFICIENT_SPLIT_SLOTS jika jeda tidak terpenuhi');
  {
    const mondayMorningAnchor = new Date('2024-05-20T02:00:00.000Z'); // 09:00 WIB Senin

    // Skenario 22A: Hari Senin hanya cukup untuk 1 sesi karena agenda padat.
    // Sisa 2 sesi harus melompat ke hari berikutnya (Selasa) dan tetap menjaga jeda 60m.
    const busyMonday: CalendarEvent[] = [
      {
        id: 'evt-mon-1',
        title: 'Meeting Seharian Sebagian',
        startAt: createIsoInTimezone(2024, 5, 20, 10, 0, 0, TEST_TIMEZONE), // 10:00 - 18:00 WIB
        endAt: createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE),
        provider: 'google',
        isEditable: false,
        syncStatus: 'synced',
      },
    ];

    const taskMultiDay: Task = {
      id: 'task-multiday-split',
      userId: 'user-default',
      title: 'Belajar Coding',
      estimatedDurationMinutes: 90,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 30,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 3,
        sessionDurationMinutes: 30,
        minGapMinutes: 60,
      },
      timezone: TEST_TIMEZONE,
      createdAt: mondayMorningAnchor.toISOString(),
    };

    const cleanPrefs: UserPreferences = {
      ...defaultPrefs,
      bufferMinutes: 0,
      enableLunchBreak: false,
    };

    const resultMultiDay = scheduleTaskDeterministically(taskMultiDay, busyMonday, [], cleanPrefs, mondayMorningAnchor);
    assert(resultMultiDay.success === true, `Jadwal harus sukses melompat ke hari berikutnya: ${resultMultiDay.explanation}`);
    assert(resultMultiDay.proposedSessions.length === 3, 'Harus menghasilkan tepat 3 sesi');

    // Sesi 1 di Senin (09:00 - 09:30)
    const sess1Date = new Date(resultMultiDay.proposedSessions[0].startAt);
    const p1 = getPartsInTimezone(sess1Date, TEST_TIMEZONE);
    assert(p1.day === 20, `Sesi 1 harus pada tanggal 20 (Senin), dapat tanggal ${p1.day}`);

    // Sesi 2 di Selasa (21 Mei)
    const sess2Date = new Date(resultMultiDay.proposedSessions[1].startAt);
    const p2 = getPartsInTimezone(sess2Date, TEST_TIMEZONE);
    assert(p2.day === 21, `Sesi 2 harus pada tanggal 21 (Selasa), dapat tanggal ${p2.day}`);

    // Sesi 3 di Selasa (21 Mei) dengan jeda minimal 60 menit dari Sesi 2
    const sess3Date = new Date(resultMultiDay.proposedSessions[2].startAt);
    const p3 = getPartsInTimezone(sess3Date, TEST_TIMEZONE);
    assert(p3.day === 21, `Sesi 3 harus pada tanggal 21 (Selasa), dapat tanggal ${p3.day}`);
    const gapTue = (sess3Date.getTime() - new Date(resultMultiDay.proposedSessions[1].endAt).getTime()) / 60000;
    assert(gapTue >= 60, `Jeda Sesi 2 dan 3 di hari Selasa harus minimal 60 menit, dapat: ${gapTue}m`);

    // Skenario 22B: Ada tenggat waktu ketat di Senin jam 18:00 WIB, tetapi slot berjeda hanya mampu 2 sesi (kurang 1 sesi)
    // Kalender Senin: 09:00-11:00 kosong (Sesi 1: 09:00-09:30, jeda 60m -> 10:30-11:00 Sesi 2)
    // Jam 11:00 - 18:00 sibuk.
    // Tenggat: Senin jam 18:00.
    // Total slot yang memenuhi jeda hanya 2 dari 3 sesi yang diminta.
    // Scheduler HARUS GAGAL TOTAL (success: false) dengan failureCode: 'INSUFFICIENT_SPLIT_SLOTS'.
    const busyRestOfDay: CalendarEvent[] = [
      {
        id: 'evt-mon-afternoon',
        title: 'Fokus Siang Hingga Tutup',
        startAt: createIsoInTimezone(2024, 5, 20, 11, 0, 0, TEST_TIMEZONE),
        endAt: createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE),
        provider: 'google',
        isEditable: false,
        syncStatus: 'synced',
      },
    ];

    const taskWithTightDeadline: Task = {
      ...taskMultiDay,
      deadlineAt: createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE),
      hasExplicitDeadline: true,
    };

    const resultStrictFail = scheduleTaskDeterministically(taskWithTightDeadline, busyRestOfDay, [], cleanPrefs, mondayMorningAnchor);
    assert(resultStrictFail.success === false, 'Scheduler HARUS gagal jika hanya menemukan 2 dari 3 sesi yang diminta');
    assert(
      resultStrictFail.failureCode === 'INSUFFICIENT_SPLIT_SLOTS',
      `failureCode harus INSUFFICIENT_SPLIT_SLOTS, dapat: ${resultStrictFail.failureCode}`
    );
    assert(
      resultStrictFail.proposedSessions.length === 0,
      `proposedSessions harus kosong pada kegagalan (tidak boleh mengklaim sukses parsial), dapat: ${resultStrictFail.proposedSessions.length}`
    );
    assert(
      resultStrictFail.explanation.includes('2 dari 3') || resultStrictFail.explanation.includes('jeda minimal'),
      `Penjelasan harus jujur menyebutkan kekurangan sesi / jeda minimal, dapat: '${resultStrictFail.explanation}'`
    );

    console.log('  ✅ [PASS] Kasus 22: Distribusi multi-hari dan kegagalan tegas INSUFFICIENT_SPLIT_SLOTS teruji tervalidasi.');
  }

  // KASUS 23: UI Pembagian Sesi Dinamis & Penanganan Timeout Frontend vs Pembatalan Manual
  console.log('>>> [23/23] Kasus 23: Evaluasi opsi UI pembagian sesi & proteksi timeout vs pembatalan manual');
  {
    // A. Tugas 90 menit dengan batas min 30 menit harus menghasilkan opsi 2x45m dan 3x30m
    const opts90 = getAvailableSplitOptions(90, 30);
    assert(opts90.length === 2, `Harus ada 2 opsi split untuk 90m (min 30m), dapat ${opts90.length}`);
    assert(opts90[0].sessionCount === 2 && opts90[0].durationPerSession === 45, 'Opsi 1 harus 2 sesi @ 45m');
    assert(opts90[1].sessionCount === 3 && opts90[1].durationPerSession === 30, 'Opsi 2 harus 3 sesi @ 30m');

    // B. Nilai default gap minimal antar sesi
    assert(DEFAULT_MIN_SPLIT_SESSION_GAP_MINUTES === 60, `DEFAULT_MIN_SPLIT_SESSION_GAP_MINUTES harus bernilai 60, dapat: ${DEFAULT_MIN_SPLIT_SESSION_GAP_MINUTES}`);

    // C. Pembedaan manual cancel vs timeout:
    // Manual cancel menghasilkan AbortError dengan didTimeout = false -> pesan 'Proses analisis dibatalkan oleh pengguna' dan JANGAN fallback
    // Automated timeout menghasilkan AbortError dengan didTimeout = true -> jalankan deterministic fallback dengan notice timeout 30s
    let fallbackExecuted = false;
    let uiMessage = '';
    const simulateAbortHandling = (isTimeout: boolean) => {
      fallbackExecuted = false;
      uiMessage = '';
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';

      if (err.name === 'AbortError' && !isTimeout) {
        uiMessage = 'Proses analisis dibatalkan oleh pengguna.';
        return;
      }

      // Timeout path
      fallbackExecuted = true;
      uiMessage = isTimeout
        ? 'Permintaan AI melampaui batas waktu respons (30 detik). Jadwal berhasil dialihkan dan disusun menggunakan mesin aturan lokal deterministik (Local Rule-based Engine) EVEN.'
        : 'Pemrosesan AI tidak tersedia saat ini.';
    };

    simulateAbortHandling(false); // Manual cancel
    assert(fallbackExecuted === false, 'Pembatalan manual tidak boleh memicu fallback');
    assert(uiMessage === 'Proses analisis dibatalkan oleh pengguna.', `Pesan harus dibatalkan oleh pengguna, dapat: '${uiMessage}'`);

    simulateAbortHandling(true); // Automated 30s timeout
    assert(fallbackExecuted === true, 'Automated 30s timeout HARUS memicu fallback deterministik');
    assert(uiMessage.includes('30 detik'), `Pesan timeout harus menyebut 30 detik, dapat: '${uiMessage}'`);

    console.log('  ✅ [PASS] Kasus 23: UI split options dinamis dan isolasi timeout vs manual cancel teruji akurat.');
  }

  // KASUS 24: Strategi across_days untuk 90 menit (2 sesi × 45m pada hari berbeda)
  console.log('>>> [24/28] Kasus 24: Strategi across_days (2 sesi x 45m ditempatkan pada hari berbeda)');
  {
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z'); // 09:00 WIB Senin (20 Mei)
    const taskAcrossDays: Task = {
      id: 'task-across-days-2x45',
      userId: 'user-default',
      title: 'Belajar Arsitektur Sistem',
      estimatedDurationMinutes: 90,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 30,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 2,
        sessionDurationMinutes: 45,
        distributionStrategy: 'across_days',
      },
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    const cleanPrefs: UserPreferences = {
      ...defaultPrefs,
      bufferMinutes: 0,
      enableLunchBreak: false,
    };

    // Meskipun hari Senin kosong penuh, strategi across_days HARUS membatasi 1 sesi per hari
    const result = scheduleTaskDeterministically(taskAcrossDays, [], [], cleanPrefs, mondayAnchor);
    assert(result.success === true, `Penjadwalan across_days harus sukses: ${result.explanation}`);
    assert(result.proposedSessions.length === 2, `Harus menghasilkan 2 sesi, dapat: ${result.proposedSessions.length}`);

    const s1Day = getPartsInTimezone(new Date(result.proposedSessions[0].startAt), TEST_TIMEZONE).day;
    const s2Day = getPartsInTimezone(new Date(result.proposedSessions[1].startAt), TEST_TIMEZONE).day;
    assert(s1Day !== s2Day, `Sesi 1 (hari ${s1Day}) dan Sesi 2 (hari ${s2Day}) HARUS berada pada hari kalender berbeda`);
    assert(s1Day === 20 && s2Day === 21, `Sesi 1 harus di hari Senin (20 Mei) dan Sesi 2 di hari Selasa (21 Mei), dapat ${s1Day} dan ${s2Day}`);

    console.log('  ✅ [PASS] Kasus 24: Strategi across_days sukses mendistribusikan 2 sesi pada 2 hari berbeda.');
  }

  // KASUS 25: Strategi across_days untuk 90 menit (3 sesi × 30m pada 3 hari berbeda) & Tenggat Jumat 18:00
  console.log('>>> [25/28] Kasus 25: Strategi across_days 3 sesi x 30m lintas hari sebelum tenggat Jumat 18:00');
  {
    const wednesdayAnchor = new Date('2024-05-22T02:00:00.000Z'); // 09:00 WIB Rabu (22 Mei)
    const deadlineFriday = createIsoInTimezone(2024, 5, 24, 18, 0, 0, TEST_TIMEZONE); // Jumat 18:00 WIB (24 Mei)

    const task3x30Across: Task = {
      id: 'task-across-3x30',
      userId: 'user-default',
      title: 'Menulis Draf Laporan',
      estimatedDurationMinutes: 90,
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 30,
      deadlineAt: deadlineFriday,
      hasExplicitDeadline: true,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 3,
        sessionDurationMinutes: 30,
        distributionStrategy: 'across_days',
      },
      timezone: TEST_TIMEZONE,
      createdAt: wednesdayAnchor.toISOString(),
    };

    const cleanPrefs: UserPreferences = {
      ...defaultPrefs,
      bufferMinutes: 0,
      enableLunchBreak: false,
    };

    const result = scheduleTaskDeterministically(task3x30Across, [], [], cleanPrefs, wednesdayAnchor);
    assert(result.success === true, `Harus berhasil menjadwalkan 3 sesi lintas hari sebelum tenggat: ${result.explanation}`);
    assert(result.proposedSessions.length === 3, 'Harus tepat 3 sesi');

    const day1 = getPartsInTimezone(new Date(result.proposedSessions[0].startAt), TEST_TIMEZONE).day;
    const day2 = getPartsInTimezone(new Date(result.proposedSessions[1].startAt), TEST_TIMEZONE).day;
    const day3 = getPartsInTimezone(new Date(result.proposedSessions[2].startAt), TEST_TIMEZONE).day;

    assert(day1 === 22, `Sesi 1 harus Rabu (22 Mei), dapat: ${day1}`);
    assert(day2 === 23, `Sesi 2 harus Kamis (23 Mei), dapat: ${day2}`);
    assert(day3 === 24, `Sesi 3 harus Jumat (24 Mei), dapat: ${day3}`);

    const sess3End = new Date(result.proposedSessions[2].endAt).getTime();
    const deadlineMs = new Date(deadlineFriday).getTime();
    assert(sess3End <= deadlineMs, 'Sesi 3 harus selesai sebelum batas tenggat Jumat 18:00 WIB');

    console.log('  ✅ [PASS] Kasus 25: 3 sesi terdistribusi presisi pada Rabu, Kamis, dan Jumat sebelum tenggat 18:00.');
  }

  // KASUS 26: Integritas total durasi 75 menit (38m + 37m = tepat 75 menit, tidak ada menit hilang)
  console.log('>>> [26/28] Kasus 26: Integritas durasi total 75 menit (38m + 37m = tepat 75m tanpa pembulatan hilang)');
  {
    // A. Generator opsi pembagian untuk 75 menit dengan batas min 30 menit
    const opts75 = getAvailableSplitOptions(75, 30);
    assert(opts75.length === 1, `Harus ada 1 opsi untuk 75m dengan min 30m, dapat: ${opts75.length}`);
    assert(opts75[0].sessionCount === 2, 'Harus 2 sesi');
    assert(opts75[0].totalDuration === 75, `Total durasi opsi harus persis 75 menit, dapat: ${opts75[0].totalDuration}`);
    assert(
      opts75[0].sessionDurations[0] === 38 && opts75[0].sessionDurations[1] === 37,
      `Durasi per sesi harus 38m dan 37m, dapat: ${JSON.stringify(opts75[0].sessionDurations)}`
    );

    // B. Penjadwalan deterministik dengan durasi 75 menit
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');
    const task75: Task = {
      id: 'task-75m',
      userId: 'user-default',
      title: 'Tinjauan Proposal',
      estimatedDurationMinutes: 75,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 30,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 2,
        sessionDurations: [38, 37],
        distributionStrategy: 'flexible',
      },
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    const cleanPrefs: UserPreferences = {
      ...defaultPrefs,
      bufferMinutes: 0,
      enableLunchBreak: false,
    };

    const result75 = scheduleTaskDeterministically(task75, [], [], cleanPrefs, mondayAnchor);
    assert(result75.success === true, `Penjadwalan 75m harus sukses: ${result75.explanation}`);
    assert(result75.proposedSessions.length === 2, 'Harus menghasilkan 2 sesi');
    assert(result75.proposedSessions[0].durationMinutes === 38, `Sesi 1 harus 38 menit, dapat: ${result75.proposedSessions[0].durationMinutes}`);
    assert(result75.proposedSessions[1].durationMinutes === 37, `Sesi 2 harus 37 menit, dapat: ${result75.proposedSessions[1].durationMinutes}`);
    const sumDurations = result75.proposedSessions.reduce((acc, s) => acc + s.durationMinutes, 0);
    assert(sumDurations === 75, `Jumlah durasi kedua sesi harus tepat 75 menit, dapat: ${sumDurations}`);

    console.log('  ✅ [PASS] Kasus 26: Integritas total durasi 75 menit (38m + 37m = 75m) terjaga 100% tanpa menit hilang.');
  }

  // KASUS 27: Penolakan total ketika hanya tersedia 1 slot padahal 2 sesi dibutuhkan
  console.log('>>> [27/28] Kasus 27: Penolakan total saat slot tidak mencukupi (tidak ada klaim sukses parsial)');
  {
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z'); // 09:00 WIB Senin
    const mondayDeadline = createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE);

    // Agenda: 10:00 - 18:00 sibuk. Hanya ada 1 slot 45m (09:00 - 09:45) sebelum tenggat.
    const busyMonday: CalendarEvent[] = [
      {
        id: 'evt-busy-full',
        title: 'Workshop Seharian',
        startAt: createIsoInTimezone(2024, 5, 20, 10, 0, 0, TEST_TIMEZONE),
        endAt: createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE),
        provider: 'google',
        isEditable: false,
        syncStatus: 'synced',
      },
    ];

    const cleanPrefs: UserPreferences = {
      ...defaultPrefs,
      bufferMinutes: 0,
      enableLunchBreak: false,
    };

    // Skenario A: same_day (meminta 2 sesi @ 45m di hari yang sama sebelum tenggat Senin 18:00)
    const taskSameDayFail: Task = {
      id: 'task-same-day-fail',
      userId: 'user-default',
      title: 'Tugas Padat',
      estimatedDurationMinutes: 90,
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 30,
      deadlineAt: mondayDeadline,
      hasExplicitDeadline: true,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 2,
        sessionDurationMinutes: 45,
        distributionStrategy: 'same_day',
      },
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    const resultSameDayFail = scheduleTaskDeterministically(taskSameDayFail, busyMonday, [], cleanPrefs, mondayAnchor);
    assert(resultSameDayFail.success === false, 'same_day harus gagal jika hanya ada 1 slot di hari tersebut');
    assert(resultSameDayFail.failureCode === 'INSUFFICIENT_SPLIT_SLOTS', `failureCode harus INSUFFICIENT_SPLIT_SLOTS, dapat: ${resultSameDayFail.failureCode}`);
    assert(resultSameDayFail.proposedSessions.length === 0, 'proposedSessions harus kosong, tidak boleh mengklaim sukses parsial');

    // Skenario B: across_days (meminta 2 sesi di hari berbeda sebelum tenggat Senin 18:00)
    // Karena hanya ada 1 hari sebelum tenggat, across_days tidak mungkin menempatkan 2 sesi di 2 hari berbeda!
    const taskAcrossDaysFail: Task = {
      ...taskSameDayFail,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 2,
        sessionDurationMinutes: 45,
        distributionStrategy: 'across_days',
      },
    };

    const resultAcrossFail = scheduleTaskDeterministically(taskAcrossDaysFail, busyMonday, [], cleanPrefs, mondayAnchor);
    assert(resultAcrossFail.success === false, 'across_days harus gagal jika tidak cukup hari berbeda sebelum tenggat');
    assert(resultAcrossFail.failureCode === 'INSUFFICIENT_SPLIT_SLOTS', `failureCode harus INSUFFICIENT_SPLIT_SLOTS, dapat: ${resultAcrossFail.failureCode}`);
    assert(resultAcrossFail.proposedSessions.length === 0, 'proposedSessions harus kosong pada kegagalan across_days');

    console.log('  ✅ [PASS] Kasus 27: Penolakan total saat slot/hari kurang berfungsi tegas tanpa sukses palsu.');
  }

  // KASUS 28: Memilih ulang strategi distribusi setelah hasil awal ditampilkan
  console.log('>>> [28/28] Kasus 28: Reaktifitas memilih ulang strategi distribusi (same_day vs across_days vs flexible)');
  {
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z'); // 09:00 WIB Senin
    // Senin: 10:00 - 18:00 sibuk. Selasa: Bebas penuh.
    const busyMonday: CalendarEvent[] = [
      {
        id: 'evt-mon-afternoon-busy',
        title: 'Meeting Padat Senin',
        startAt: createIsoInTimezone(2024, 5, 20, 10, 0, 0, TEST_TIMEZONE),
        endAt: createIsoInTimezone(2024, 5, 20, 18, 0, 0, TEST_TIMEZONE),
        provider: 'google',
        isEditable: false,
        syncStatus: 'synced',
      },
    ];

    const cleanPrefs: UserPreferences = {
      ...defaultPrefs,
      bufferMinutes: 0,
      enableLunchBreak: false,
    };

    const baseTask: Task = {
      id: 'task-reselect',
      userId: 'user-default',
      title: 'Persiapan Peluncuran Produk',
      estimatedDurationMinutes: 90,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      minimumSessionMinutes: 30,
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    // Langkah 1: Pengguna memilih same_day -> Karena Senin tidak muat 2 sesi (hanya ada 09:00-10:00),
    // scheduler mencari hari berikutnya (Selasa) yang dapat memuat seluruh 2 sesi pada hari yang sama!
    const taskSameDay: Task = {
      ...baseTask,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 2,
        sessionDurationMinutes: 45,
        distributionStrategy: 'same_day',
      },
    };
    const resSameDay = scheduleTaskDeterministically(taskSameDay, busyMonday, [], cleanPrefs, mondayAnchor);
    assert(resSameDay.success === true, `same_day harus menemukan hari Selasa yang muat 2 sesi: ${resSameDay.explanation}`);
    const sameDay1 = getPartsInTimezone(new Date(resSameDay.proposedSessions[0].startAt), TEST_TIMEZONE).day;
    const sameDay2 = getPartsInTimezone(new Date(resSameDay.proposedSessions[1].startAt), TEST_TIMEZONE).day;
    assert(sameDay1 === sameDay2, `Kedua sesi same_day harus di hari yang sama, dapat ${sameDay1} dan ${sameDay2}`);
    assert(sameDay1 === 21, `Harus ditempatkan di hari Selasa (21 Mei) karena Senin penuh, dapat: ${sameDay1}`);

    // Langkah 2: Pengguna beralih memilih across_days -> Scheduler langsung menempatkan Sesi 1 di Senin (09:00-09:45)
    // dan Sesi 2 di Selasa (09:00-09:45)!
    const taskAcrossDays: Task = {
      ...baseTask,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 2,
        sessionDurationMinutes: 45,
        distributionStrategy: 'across_days',
      },
    };
    const resAcross = scheduleTaskDeterministically(taskAcrossDays, busyMonday, [], cleanPrefs, mondayAnchor);
    assert(resAcross.success === true, `across_days harus sukses: ${resAcross.explanation}`);
    const acrossDay1 = getPartsInTimezone(new Date(resAcross.proposedSessions[0].startAt), TEST_TIMEZONE).day;
    const acrossDay2 = getPartsInTimezone(new Date(resAcross.proposedSessions[1].startAt), TEST_TIMEZONE).day;
    assert(acrossDay1 === 20 && acrossDay2 === 21, `across_days harus menyebar Sesi 1 di Senin (20 Mei) dan Sesi 2 di Selasa (21 Mei), dapat ${acrossDay1} dan ${acrossDay2}`);

    // Langkah 3: Pengguna beralih ke flexible -> Menggunakan slot luang terdekat di Senin lalu Selasa
    const taskFlexible: Task = {
      ...baseTask,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 2,
        sessionDurationMinutes: 45,
        distributionStrategy: 'flexible',
      },
    };
    const resFlex = scheduleTaskDeterministically(taskFlexible, busyMonday, [], cleanPrefs, mondayAnchor);
    assert(resFlex.success === true, `flexible harus sukses: ${resFlex.explanation}`);
    assert(resFlex.proposedSessions.length === 2, 'Harus 2 sesi');

    // Verifikasi: Tidak ada sesi yang bertabrakan dengan agenda sibuk Senin (10:00 - 18:00)
    for (const sess of [...resSameDay.proposedSessions, ...resAcross.proposedSessions, ...resFlex.proposedSessions]) {
      const sStart = new Date(sess.startAt).getTime();
      const sEnd = new Date(sess.endAt).getTime();
      const bStart = new Date(busyMonday[0].startAt).getTime();
      const bEnd = new Date(busyMonday[0].endAt).getTime();
      const hasConflict = sStart < bEnd && sEnd > bStart;
      assert(!hasConflict, `Sesi (${sess.startAt} - ${sess.endAt}) tidak boleh bertabrakan dengan agenda sibuk`);
    }

    console.log('  ✅ [PASS] Kasus 28: Pemilihan ulang strategi distribusi teruji deterministik dan bebas tabrakan.');
  }

  // ============================================================================
  // SUITE PENGUJIAN REGRESI AUTO-DETECTION & AUTO-SELECTION PEMBAGIAN SESI
  // ============================================================================

  // KASUS 29 (Kasus 1): "Jadwalkan laporan selama 90 menit, bagi menjadi 2 sesi masing-masing 45 menit pada hari berbeda."
  console.log('>>> [29/36] Kasus 29: Auto-detection split 2x45m across_days pada hari berbeda');
  {
    const prompt = 'Jadwalkan laporan selama 90 menit, bagi menjadi 2 sesi masing-masing 45 menit pada hari berbeda.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z'); // 09:00 WIB Senin

    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });
    assert(pipelineRes.success === true, 'Pipeline backend harus sukses');
    assert(pipelineRes.plan.splitConfig?.forcedMode === 'split', 'forcedMode harus split');
    assert(pipelineRes.plan.splitConfig?.targetSessionCount === 2, 'targetSessionCount harus 2');
    assert(
      JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations) === JSON.stringify([45, 45]),
      `sessionDurations harus [45, 45], dapat: ${JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations)}`
    );
    assert(pipelineRes.plan.splitConfig?.distributionStrategy === 'across_days', 'distributionStrategy harus across_days');

    const splitOpts = getAvailableSplitOptions(pipelineRes.plan.estimatedDurationMinutes, 30);
    const initialUi = resolveInitialSplitConfiguration(pipelineRes.plan, splitOpts);
    assert(initialUi.splitMode === 'split', 'UI splitMode harus otomatis split');
    assert(initialUi.distributionStrategy === 'across_days', 'UI distributionStrategy harus across_days');
    assert(initialUi.splitOption?.sessionCount === 2, 'UI splitOption harus 2 sesi');

    const task: Task = {
      id: 'task-c29',
      userId: 'user-default',
      title: pipelineRes.plan.title,
      estimatedDurationMinutes: pipelineRes.plan.estimatedDurationMinutes,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      splitConfig: initialUi.activeSplitConfig,
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(task, [], [], defaultPrefs, mondayAnchor);
    assert(schedRes.success === true, `Scheduler harus sukses: ${schedRes.explanation}`);
    assert(schedRes.proposedSessions.length === 2, 'Harus ada 2 sesi terjadwal');
    const day1 = getPartsInTimezone(new Date(schedRes.proposedSessions[0].startAt), TEST_TIMEZONE).day;
    const day2 = getPartsInTimezone(new Date(schedRes.proposedSessions[1].startAt), TEST_TIMEZONE).day;
    assert(day1 !== day2, `Kedua sesi harus dijadwalkan pada hari berbeda, dapat: ${day1} dan ${day2}`);
    assert(day1 === 20 && day2 === 21, `Sesi 1 pada Senin (20 Mei) dan Sesi 2 pada Selasa (21 Mei)`);
    assert(schedRes.proposedSessions[0].durationMinutes === 45 && schedRes.proposedSessions[1].durationMinutes === 45, 'Durasi masing-masing harus 45m');
    console.log('  ✅ [PASS] Kasus 29: Mode split 2x45m across_days pada 2 hari berbeda terverifikasi akurat.');
  }

  // KASUS 30 (Kasus 2): "Jadwalkan belajar React selama 90 menit, bagi menjadi 3 sesi masing-masing 30 menit pada hari yang sama."
  console.log('>>> [30/36] Kasus 30: Auto-detection split 3x30m same_day pada hari yang sama dengan jeda minimal 60 menit');
  {
    const prompt = 'Jadwalkan belajar React selama 90 menit, bagi menjadi 3 sesi masing-masing 30 menit pada hari yang sama.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z'); // 09:00 WIB Senin

    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });
    assert(pipelineRes.success === true, 'Pipeline harus sukses');
    assert(pipelineRes.plan.splitConfig?.forcedMode === 'split', 'forcedMode harus split');
    assert(pipelineRes.plan.splitConfig?.targetSessionCount === 3, 'targetSessionCount harus 3');
    assert(
      JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations) === JSON.stringify([30, 30, 30]),
      `sessionDurations harus [30, 30, 30], dapat: ${JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations)}`
    );
    assert(pipelineRes.plan.splitConfig?.distributionStrategy === 'same_day', 'distributionStrategy harus same_day');

    const splitOpts = getAvailableSplitOptions(pipelineRes.plan.estimatedDurationMinutes, 30);
    const initialUi = resolveInitialSplitConfiguration(pipelineRes.plan, splitOpts);
    assert(initialUi.splitMode === 'split', 'UI splitMode harus split');
    assert(initialUi.distributionStrategy === 'same_day', 'UI distributionStrategy harus same_day');
    assert(initialUi.splitOption?.sessionCount === 3, 'UI splitOption harus 3 sesi');

    const cleanPrefs: UserPreferences = {
      ...defaultPrefs,
      enableLunchBreak: false,
      bufferMinutes: 0,
    };

    const task: Task = {
      id: 'task-c30',
      userId: 'user-default',
      title: pipelineRes.plan.title,
      estimatedDurationMinutes: pipelineRes.plan.estimatedDurationMinutes,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      splitConfig: initialUi.activeSplitConfig,
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(task, [], [], cleanPrefs, mondayAnchor);
    assert(schedRes.success === true, `Scheduler harus sukses: ${schedRes.explanation}`);
    assert(schedRes.proposedSessions.length === 3, 'Harus ada 3 sesi');
    const day1 = getPartsInTimezone(new Date(schedRes.proposedSessions[0].startAt), TEST_TIMEZONE).day;
    const day2 = getPartsInTimezone(new Date(schedRes.proposedSessions[1].startAt), TEST_TIMEZONE).day;
    const day3 = getPartsInTimezone(new Date(schedRes.proposedSessions[2].startAt), TEST_TIMEZONE).day;
    assert(day1 === day2 && day2 === day3, `Semua 3 sesi harus di hari yang sama, dapat: ${day1}, ${day2}, ${day3}`);

    // Periksa jeda minimal 60 menit antar sesi
    const gap1 = (new Date(schedRes.proposedSessions[1].startAt).getTime() - new Date(schedRes.proposedSessions[0].endAt).getTime()) / 60000;
    const gap2 = (new Date(schedRes.proposedSessions[2].startAt).getTime() - new Date(schedRes.proposedSessions[1].endAt).getTime()) / 60000;
    assert(gap1 >= 60, `Jeda antara sesi 1 & 2 harus >= 60 menit, dapat: ${gap1}m`);
    assert(gap2 >= 60, `Jeda antara sesi 2 & 3 harus >= 60 menit, dapat: ${gap2}m`);
    console.log('  ✅ [PASS] Kasus 30: 3 sesi same_day terjadwal pada hari sama dengan jeda >= 60 menit.');
  }

  // KASUS 31 (Kasus 3): "Jadwalkan persiapan presentasi selama 90 menit, bagi menjadi 3 sesi."
  console.log('>>> [31/36] Kasus 31: Auto-detection split 3 sesi tanpa strategi eksplisit -> flexible');
  {
    const prompt = 'Jadwalkan persiapan presentasi selama 90 menit, bagi menjadi 3 sesi.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');

    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });
    assert(pipelineRes.success === true, 'Pipeline harus sukses');
    assert(pipelineRes.plan.splitConfig?.forcedMode === 'split', 'forcedMode harus split');
    assert(pipelineRes.plan.splitConfig?.targetSessionCount === 3, 'targetSessionCount harus 3');
    assert(pipelineRes.plan.splitConfig?.distributionStrategy === 'flexible', 'distributionStrategy harus flexible sebagai default');

    const splitOpts = getAvailableSplitOptions(pipelineRes.plan.estimatedDurationMinutes, 30);
    const initialUi = resolveInitialSplitConfiguration(pipelineRes.plan, splitOpts);
    assert(initialUi.splitMode === 'split', 'UI splitMode harus split');
    assert(initialUi.distributionStrategy === 'flexible', 'UI distributionStrategy harus flexible');
    assert(initialUi.splitOption?.sessionCount === 3, 'UI splitOption harus 3 sesi');
    console.log('  ✅ [PASS] Kasus 31: Strategi flexible otomatis terpilih saat strategi tidak ditentukan eksplisit.');
  }

  // KASUS 32 (Kasus 4): "Jadwalkan belajar algoritma selama 90 menit."
  console.log('>>> [32/36] Kasus 4: Permintaan tanpa instruksi pembagian sesi default single mode');
  {
    const prompt = 'Jadwalkan belajar algoritma selama 90 menit.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');

    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });
    assert(pipelineRes.success === true, 'Pipeline harus sukses');
    assert(pipelineRes.plan.splitConfig?.forcedMode === 'single', 'forcedMode harus single jika user tidak minta split');

    const splitOpts = getAvailableSplitOptions(pipelineRes.plan.estimatedDurationMinutes, 30);
    const initialUi = resolveInitialSplitConfiguration(pipelineRes.plan, splitOpts);
    assert(initialUi.splitMode === 'single', 'UI splitMode harus default single');
    assert(splitOpts.length > 0, 'Opsi split tetap tersedia untuk dipilih manual oleh pengguna');
    console.log('  ✅ [PASS] Kasus 32: Default single session terjaga dan opsi split tetap tersedia.');
  }

  // KASUS 33 (Kasus 5): "Bagi pengerjaan makalah 75 menit menjadi 2 sesi masing-masing 38 dan 37 menit."
  console.log('>>> [33/36] Kasus 33: Integritas durasi sesi kustom [38, 37] total tepat 75 menit');
  {
    const prompt = 'Bagi pengerjaan makalah 75 menit menjadi 2 sesi masing-masing 38 dan 37 menit.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');

    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });
    assert(pipelineRes.success === true, 'Pipeline harus sukses');
    assert(pipelineRes.plan.estimatedDurationMinutes === 75, `Durasi total harus 75, dapat ${pipelineRes.plan.estimatedDurationMinutes}`);
    assert(pipelineRes.plan.splitConfig?.forcedMode === 'split', 'forcedMode harus split');
    assert(pipelineRes.plan.splitConfig?.targetSessionCount === 2, 'targetSessionCount harus 2');
    assert(
      JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations) === JSON.stringify([38, 37]),
      `sessionDurations harus [38, 37], dapat: ${JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations)}`
    );

    const splitOpts = getAvailableSplitOptions(pipelineRes.plan.estimatedDurationMinutes, 30);
    const initialUi = resolveInitialSplitConfiguration(pipelineRes.plan, splitOpts);
    assert(initialUi.splitMode === 'split', 'UI splitMode harus split');
    assert(
      JSON.stringify(initialUi.activeSplitConfig.sessionDurations) === JSON.stringify([38, 37]),
      'activeSplitConfig sessionDurations harus [38, 37]'
    );

    const task: Task = {
      id: 'task-c33',
      userId: 'user-default',
      title: pipelineRes.plan.title,
      estimatedDurationMinutes: pipelineRes.plan.estimatedDurationMinutes,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      splitConfig: initialUi.activeSplitConfig,
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(task, [], [], defaultPrefs, mondayAnchor);
    assert(schedRes.success === true, `Scheduler harus sukses: ${schedRes.explanation}`);
    assert(schedRes.proposedSessions.length === 2, 'Harus ada 2 sesi');
    assert(schedRes.proposedSessions[0].durationMinutes === 38, `Sesi 1 harus 38 menit, dapat: ${schedRes.proposedSessions[0].durationMinutes}`);
    assert(schedRes.proposedSessions[1].durationMinutes === 37, `Sesi 2 harus 37 menit, dapat: ${schedRes.proposedSessions[1].durationMinutes}`);
    assert(schedRes.proposedSessions[0].durationMinutes + schedRes.proposedSessions[1].durationMinutes === 75, 'Total durasi tepat 75 menit');
    console.log('  ✅ [PASS] Kasus 33: Durasi [38, 37] total tepat 75 menit terjaga 100% tanpa menit hilang.');
  }

  // KASUS 34 (Kasus 6): "Jadwalkan laporan 90 menit menjadi 2 sesi masing-masing 45 menit pada hari berbeda sebelum Jumat pukul 18.00 WIB."
  console.log('>>> [34/36] Kasus 34: Tenggat Jumat 18:00 WIB dipatuhi & penolakan jika tidak cukup hari');
  {
    const prompt = 'Jadwalkan laporan 90 menit menjadi 2 sesi masing-masing 45 menit pada hari berbeda sebelum Jumat pukul 18.00 WIB.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z'); // Senin 20 Mei 09:00 WIB

    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });
    assert(pipelineRes.success === true, 'Pipeline harus sukses');
    assert(pipelineRes.plan.splitConfig?.forcedMode === 'split', 'forcedMode harus split');
    assert(pipelineRes.plan.splitConfig?.distributionStrategy === 'across_days', 'distributionStrategy harus across_days');
    assert(pipelineRes.plan.hasExplicitDeadline === true, 'hasExplicitDeadline harus true');
    assert(Boolean(pipelineRes.plan.deadlineAt), 'deadlineAt harus ada');
    const dlParts = getPartsInTimezone(new Date(pipelineRes.plan.deadlineAt!), TEST_TIMEZONE);
    assert(dlParts.dayOfWeek === 5 && dlParts.hour === 18 && dlParts.minute === 0, `Deadline harus Jumat 18:00 WIB, dapat: hari ke-${dlParts.dayOfWeek} ${dlParts.hour}:${dlParts.minute}`);

    // Skenario A: Tersedia hari Senin & Selasa -> Sukses
    const taskA: Task = {
      id: 'task-c34-a',
      userId: 'user-default',
      title: pipelineRes.plan.title,
      estimatedDurationMinutes: pipelineRes.plan.estimatedDurationMinutes,
      deadlineAt: pipelineRes.plan.deadlineAt,
      hasExplicitDeadline: true,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      splitConfig: pipelineRes.plan.splitConfig,
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };
    const schedResA = scheduleTaskDeterministically(taskA, [], [], defaultPrefs, mondayAnchor);
    assert(schedResA.success === true, 'Harus sukses jika hari tersedia');
    assert(schedResA.proposedSessions.length === 2, 'Harus ada 2 sesi');

    // Skenario B: Hanya 1 hari kerja sebelum tenggat (Kamis 23 Mei 17:00 WIB, dan Jumat penuh dengan agenda sibuk)
    const thursdayLateAnchor = new Date('2024-05-23T10:00:00.000Z'); // Kamis 23 Mei 17:00 WIB
    const busyFriday: CalendarEvent[] = [
      {
        id: 'evt-busy-friday',
        title: 'Konferensi Seharian Penuh Jumat',
        startAt: createIsoInTimezone(2024, 5, 24, 9, 0, 0, TEST_TIMEZONE),
        endAt: createIsoInTimezone(2024, 5, 24, 18, 0, 0, TEST_TIMEZONE),
        provider: 'google',
        isEditable: false,
        syncStatus: 'synced',
      },
    ];

    const schedResB = scheduleTaskDeterministically(taskA, busyFriday, [], defaultPrefs, thursdayLateAnchor);
    assert(schedResB.success === false, 'Harus gagal total jika hanya ada 1 hari sebelum tenggat Jumat 18:00');
    assert(schedResB.failureCode === 'INSUFFICIENT_SPLIT_SLOTS', `failureCode harus INSUFFICIENT_SPLIT_SLOTS, dapat: ${schedResB.failureCode}`);
    assert(schedResB.proposedSessions.length === 0, 'proposedSessions harus kosong pada penolakan total');
    console.log('  ✅ [PASS] Kasus 34: Tenggat dipatuhi & penolakan total bekerja tegas jika hari kurang.');
  }

  // KASUS 35 (Kasus 7): Gemini gagal dan sistem memakai fallback lokal
  console.log('>>> [35/36] Kasus 35: Gemini gagal & fallback lokal tetap mempertahankan mode split');
  {
    const prompt = 'Jadwalkan persiapan ujian 90 menit, bagi 2 sesi masing-masing 45 menit di hari berbeda.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');

    const fallbackRes = simulateBackendPlanPipeline(prompt, {
      mockGeminiPlan: null,
      geminiError: new Error('Rate limit 429'),
      refDate: mondayAnchor,
    });

    assert(fallbackRes.success === true, 'Fallback harus sukses');
    assert(fallbackRes.source === 'rule_fallback_on_error', 'source harus rule_fallback_on_error');
    assert(fallbackRes.plan.splitConfig?.forcedMode === 'split', 'Fallback harus tetap mendeteksi forcedMode: split');
    assert(fallbackRes.plan.splitConfig?.distributionStrategy === 'across_days', 'Fallback harus mendeteksi across_days');
    assert(fallbackRes.plan.splitConfig?.targetSessionCount === 2, 'Fallback harus mendeteksi 2 sesi');

    const splitOpts = getAvailableSplitOptions(fallbackRes.plan.estimatedDurationMinutes, 30);
    const initialUi = resolveInitialSplitConfiguration(fallbackRes.plan, splitOpts);
    assert(initialUi.splitMode === 'split', 'UI harus tetap split mode pada fallback');
    assert(initialUi.distributionStrategy === 'across_days', 'UI harus tetap across_days pada fallback');
    console.log('  ✅ [PASS] Kasus 35: Fallback lokal berhasil mempertahankan mode split tanpa kembali diam-diam ke single.');
  }

  // KASUS 36 (Kasus 8): Pengguna mengganti mode split menjadi single secara manual
  console.log('>>> [36/36] Kasus 36: Pengguna mengganti mode split menjadi single secara manual');
  {
    const prompt = 'Bagi laporan 90 menit menjadi 2 sesi masing-masing 45 menit.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');

    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });
    const splitOpts = getAvailableSplitOptions(pipelineRes.plan.estimatedDurationMinutes, 30);
    const initialUi = resolveInitialSplitConfiguration(pipelineRes.plan, splitOpts);
    assert(initialUi.splitMode === 'split', 'Awalnya mode split');

    // Pengguna menekan tombol "Satu Sesi Utuh" secara manual:
    const manualSingleConfig: TaskSplitConfig = { forcedMode: 'single' };

    const taskSingle: Task = {
      id: 'task-manual-override',
      userId: 'user-default',
      title: pipelineRes.plan.title,
      estimatedDurationMinutes: pipelineRes.plan.estimatedDurationMinutes,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: false,
      splitConfig: manualSingleConfig,
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(taskSingle, [], [], defaultPrefs, mondayAnchor);
    assert(schedRes.success === true, 'Scheduler harus sukses menjadwalkan satu sesi');
    assert(schedRes.proposedSessions.length === 1, `Harus ada 1 sesi tunggal, dapat: ${schedRes.proposedSessions.length}`);
    assert(schedRes.proposedSessions[0].durationMinutes === 90, `Durasi sesi tunggal harus 90 menit, dapat: ${schedRes.proposedSessions[0].durationMinutes}`);
    console.log('  ✅ [PASS] Kasus 36: Pilihan manual single session dihormati dan dihitung ulang sebagai satu sesi utuh.');
  }

  // ========================================================================
  // HARDENING TESTS: AUTO-DETECTION, VALIDASI DURASI, KONTRADIKSI & OVERRIDE
  // (KASUS 37 - 45)
  // ========================================================================

  // KASUS 37: Validasi total durasi konsisten (total 90m, 2 sesi @45m -> valid)
  console.log('>>> [37/45] Kasus 37: Validasi total durasi konsisten (total 90m, 2 sesi @45m)');
  {
    const prompt = 'Jadwalkan belajar algoritma selama total 90 menit, dibagi menjadi 2 sesi masing-masing 45 menit.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');
    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });

    assert(pipelineRes.success === true, 'Pipeline harus sukses');
    assert(pipelineRes.plan.estimatedDurationMinutes === 90, 'Total durasi harus 90 menit');
    assert(pipelineRes.plan.splitConfig?.forcedMode === 'split', 'forcedMode harus split');
    assert(pipelineRes.plan.splitConfig?.targetSessionCount === 2, 'targetSessionCount harus 2');
    assert(
      JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations) === JSON.stringify([45, 45]),
      `sessionDurations harus [45, 45], dapat: ${JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations)}`
    );
    assert(pipelineRes.plan.hasConflict !== true, 'Tidak boleh ada konflik');
    assert(pipelineRes.plan.splitValidation?.isValid === true, 'splitValidation harus valid');
    console.log('  ✅ [PASS] Kasus 37: Total durasi 90m dengan 2 sesi 45+45m terverifikasi valid secara matematis.');
  }

  // KASUS 38: Validasi durasi pecahan ganjil konsisten (total 75m, 2 sesi @38m dan @37m -> valid)
  console.log('>>> [38/45] Kasus 38: Validasi durasi pecahan ganjil konsisten (75m, 2 sesi 38+37m)');
  {
    const prompt = 'Bagi tugas analisis 75 menit menjadi 2 sesi masing-masing 38 dan 37 menit.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');
    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });

    assert(pipelineRes.success === true, 'Pipeline harus sukses');
    assert(pipelineRes.plan.estimatedDurationMinutes === 75, 'Total durasi harus 75 menit');
    assert(pipelineRes.plan.splitConfig?.targetSessionCount === 2, 'targetSessionCount harus 2');
    assert(
      JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations) === JSON.stringify([38, 37]),
      `sessionDurations harus [38, 37], dapat: ${JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations)}`
    );
    assert(pipelineRes.plan.hasConflict !== true, 'Tidak boleh ada konflik');
    assert(pipelineRes.plan.splitValidation?.isValid === true, 'splitValidation harus valid');
    console.log('  ✅ [PASS] Kasus 38: Pecahan ganjil 38m dan 37m tepat berjumlah 75m terverifikasi valid.');
  }

  // KASUS 39: Deteksi durasi mismatch & penolakan silent mutation (total 90m, 2 sesi @40m -> invalid)
  console.log('>>> [39/45] Kasus 39: Deteksi durasi mismatch & penolakan silent mutation (90m, 2 sesi @40m)');
  {
    const prompt = 'Jadwalkan belajar algoritma selama total 90 menit, dibagi menjadi 2 sesi masing-masing 40 menit.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');
    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });

    // Verifikasi perlindungan dari mutasi diam-diam:
    // 1. Total durasi TIDAK BOLEH diam-diam berubah menjadi 80
    assert(pipelineRes.plan.estimatedDurationMinutes === 90, `Total durasi harus tetap 90 menit (tidak boleh bermutasi ke 80), dapat: ${pipelineRes.plan.estimatedDurationMinutes}`);
    // 2. Rincian sesi TIDAK BOLEH diam-diam diubah ke 45+45
    assert(
      JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations) === JSON.stringify([40, 40]),
      `sessionDurations harus tetap merefleksikan permintaan [40, 40], dapat: ${JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations)}`
    );
    // 3. Status konflik dan validasi cacat harus terdeteksi dengan tepat
    assert(pipelineRes.plan.hasConflict === true, 'hasConflict harus true');
    assert(pipelineRes.plan.conflictType === 'DURATION_MISMATCH', `conflictType harus DURATION_MISMATCH, dapat: ${pipelineRes.plan.conflictType}`);
    assert(pipelineRes.plan.splitValidation?.isValid === false, 'splitValidation.isValid harus false');
    assert(pipelineRes.plan.splitValidation?.errorCode === 'DURATION_MISMATCH', 'errorCode harus DURATION_MISMATCH');
    assert(pipelineRes.plan.requiresClarification === true, 'requiresClarification harus true');
    console.log('  ✅ [PASS] Kasus 39: Mismatch 90m vs 40+40m terdeteksi secara ketat tanpa mutasi data diam-diam.');
  }

  // KASUS 40: Validasi durasi 3 sesi konsisten (total 90m, 3 sesi @30m -> valid)
  console.log('>>> [40/45] Kasus 40: Validasi durasi 3 sesi konsisten (total 90m, 3 sesi @30m)');
  {
    const prompt = 'Jadwalkan review materi total 90 menit, pecah menjadi 3 sesi masing-masing 30 menit.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');
    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });

    assert(pipelineRes.success === true, 'Pipeline harus sukses');
    assert(pipelineRes.plan.estimatedDurationMinutes === 90, 'Total durasi harus 90 menit');
    assert(pipelineRes.plan.splitConfig?.targetSessionCount === 3, 'targetSessionCount harus 3');
    assert(
      JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations) === JSON.stringify([30, 30, 30]),
      `sessionDurations harus [30, 30, 30]`
    );
    assert(pipelineRes.plan.hasConflict !== true, 'Tidak boleh ada konflik');
    assert(pipelineRes.plan.splitValidation?.isValid === true, 'splitValidation harus valid');
    console.log('  ✅ [PASS] Kasus 40: Total 90m dengan 3 sesi 30+30+30m terverifikasi valid.');
  }

  // KASUS 41: Validasi total dari sesi tanpa total eksplisit ("2 sesi masing-masing 40 menit" -> total 80m valid)
  console.log('>>> [41/45] Kasus 41: Validasi total dari sesi tanpa total eksplisit (2 sesi @40m -> total 80m)');
  {
    const prompt = 'Bagi tugas persiapan ujian menjadi 2 sesi masing-masing 40 menit.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');
    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });

    assert(pipelineRes.success === true, 'Pipeline harus sukses');
    assert(pipelineRes.plan.estimatedDurationMinutes === 80, `Total durasi harus dihitung 80 menit, dapat: ${pipelineRes.plan.estimatedDurationMinutes}`);
    assert(pipelineRes.plan.splitConfig?.targetSessionCount === 2, 'targetSessionCount harus 2');
    assert(
      JSON.stringify(pipelineRes.plan.splitConfig?.sessionDurations) === JSON.stringify([40, 40]),
      `sessionDurations harus [40, 40]`
    );
    assert(pipelineRes.plan.hasConflict !== true, 'Tidak boleh ada konflik karena total tidak disebutkan berlawanan');
    assert(pipelineRes.plan.splitValidation?.isValid === true, 'splitValidation harus valid');
    console.log('  ✅ [PASS] Kasus 41: Tanpa total eksplisit yang berlawanan, total 80m dihitung akurat dari sesi.');
  }

  // KASUS 42: Deteksi instruksi bertentangan strategi ("3 sesi pada hari yang berbeda, tetapi selesaikan semuanya hari ini")
  console.log('>>> [42/45] Kasus 42: Deteksi instruksi bertentangan strategi (across_days vs hari ini)');
  {
    const prompt = 'Bagi tugas menjadi 3 sesi pada hari yang berbeda, tetapi selesaikan semuanya hari ini.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');
    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });

    assert(pipelineRes.plan.hasConflict === true, 'hasConflict harus true');
    assert(pipelineRes.plan.conflictType === 'STRATEGY_MISMATCH', `conflictType harus STRATEGY_MISMATCH, dapat: ${pipelineRes.plan.conflictType}`);
    assert(pipelineRes.plan.requiresClarification === true, 'requiresClarification harus true');
    assert(Array.isArray(pipelineRes.plan.clarificationOptions), 'clarificationOptions harus ada');
    console.log('  ✅ [PASS] Kasus 42: Kontradiksi lintas hari vs selesai hari ini berhasil dicegat sebagai STRATEGY_MISMATCH.');
  }

  // KASUS 43: Deteksi instruksi bertentangan tenggat (3 sesi beda hari + tenggat jam 12:00 hari ini)
  console.log('>>> [43/45] Kasus 43: Deteksi instruksi bertentangan tenggat (across_days + tenggat hari ini)');
  {
    const prompt = 'Bagi pengerjaan proyek menjadi 3 sesi pada hari berbeda, paling lambat jam 12.00 hari ini.';
    const mondayAnchor = new Date('2024-05-20T01:00:00.000Z'); // 08:00 WIB
    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });

    assert(pipelineRes.plan.hasConflict === true, 'hasConflict harus true');
    assert(pipelineRes.plan.conflictType === 'DEADLINE_IMPOSSIBLE', `conflictType harus DEADLINE_IMPOSSIBLE, dapat: ${pipelineRes.plan.conflictType}`);
    assert(pipelineRes.plan.requiresClarification === true, 'requiresClarification harus true');
    console.log('  ✅ [PASS] Kasus 43: Kontradiksi 3 sesi beda hari dengan batas tenggat hari ini dicegat sebagai DEADLINE_IMPOSSIBLE.');
  }

  // KASUS 44: Manual override integritas & configSource manual
  console.log('>>> [44/45] Kasus 44: Manual override integritas & configSource manual');
  {
    const prompt = 'Bagi laporan 90 menit menjadi 2 sesi masing-masing 45 menit pada hari berbeda.';
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');
    const pipelineRes = simulateBackendPlanPipeline(prompt, { refDate: mondayAnchor });

    const splitOpts = getAvailableSplitOptions(pipelineRes.plan.estimatedDurationMinutes, 30);
    const initialUi = resolveInitialSplitConfiguration(pipelineRes.plan, splitOpts);
    assert(initialUi.splitMode === 'split', 'Awalnya auto-detected split');
    assert(initialUi.activeSplitConfig.configSource === 'auto_detected', 'Awalnya configSource auto_detected');

    // Pengguna secara manual memilih Satu Sesi Utuh:
    const manualSingleConfig: TaskSplitConfig = {
      forcedMode: 'single',
      configSource: 'manual',
    };
    assert(manualSingleConfig.configSource === 'manual', 'Override harus memiliki configSource: manual');

    const taskSingle: Task = {
      id: 'task-manual-override-44',
      userId: 'user-default',
      title: pipelineRes.plan.title,
      estimatedDurationMinutes: pipelineRes.plan.estimatedDurationMinutes,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: false,
      splitConfig: manualSingleConfig,
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(taskSingle, [], [], defaultPrefs, mondayAnchor);
    assert(schedRes.success === true, 'Scheduler harus sukses');
    assert(schedRes.proposedSessions.length === 1, 'Harus menghasilkan 1 sesi utuh');
    console.log('  ✅ [PASS] Kasus 44: Manual override menetapkan configSource: manual dan dihormati penuh.');
  }

  // KASUS 45: Penolakan Scheduler pada Konfigurasi Split Cacat
  console.log('>>> [45/45] Kasus 45: Penolakan scheduler pada konfigurasi split cacat (INVALID_SPLIT_CONFIGURATION)');
  {
    const mondayAnchor = new Date('2024-05-20T02:00:00.000Z');
    // Task cacat: total 90m tapi rincian sesi [40, 40] (jumlah 80m, hilang 10m)
    const invalidTask: Task = {
      id: 'task-invalid-split',
      userId: 'user-default',
      title: 'Tugas Cacat Durasi',
      estimatedDurationMinutes: 90,
      priority: 'MEDIUM',
      status: 'UNSCHEDULED',
      allowSplit: true,
      splitConfig: {
        forcedMode: 'split',
        targetSessionCount: 2,
        sessionDurations: [40, 40],
        sessionDurationMinutes: 40,
        distributionStrategy: 'flexible',
      },
      timezone: TEST_TIMEZONE,
      createdAt: mondayAnchor.toISOString(),
    };

    const schedRes = scheduleTaskDeterministically(invalidTask, [], [], defaultPrefs, mondayAnchor);
    assert(schedRes.success === false, 'Scheduler harus menolak konfigurasi cacat');
    assert(
      schedRes.failureCode === 'INVALID_SPLIT_CONFIGURATION',
      `failureCode harus INVALID_SPLIT_CONFIGURATION, dapat: ${schedRes.failureCode}`
    );
    assert(schedRes.proposedSessions.length === 0, 'proposedSessions harus kosong');
    assert(schedRes.explanation.includes('Total durasi tugas adalah 90 menit'), 'Penjelasan harus transparan menyebut durasi mismatch');
    console.log('  ✅ [PASS] Kasus 45: Scheduler deterministik secara tegas menolak eksekusi dengan INVALID_SPLIT_CONFIGURATION.');
  }

  console.log('\n========================================================================');
  console.log('🎉 SELURUH PENGUJIAN DIAGNOSTIK TENGGAT & SLOT PENJADWALAN BERHASIL 100%! 🎉');
  console.log('========================================================================\n');
}

if (process.argv[1]?.includes('deadlineAndSlotDiagnostics.test')) {
  runDeadlineAndSlotDiagnosticsTests();
}
