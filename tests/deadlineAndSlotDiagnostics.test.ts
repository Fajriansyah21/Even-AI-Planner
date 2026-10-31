import {
  parseIndonesianTemporalRules,
  ParseContext,
} from '../src/lib/temporalParser';
import {
  scheduleTaskDeterministically,
  formatWindowTime,
  verifyAndNormalizeReferenceDate,
} from '../src/lib/scheduler';
import {
  createIsoInTimezone,
  getPartsInTimezone,
} from '../src/lib/timezone';
import { Task, CalendarEvent, UserPreferences } from '../src/types';
import { simulateBackendPlanPipeline, MOCK_REFERENCE_DATE, TEST_TIMEZONE } from './aiScheduler.test';

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

  console.log('\n========================================================================');
  console.log('🎉 SELURUH PENGUJIAN DIAGNOSTIK TENGGAT & SLOT PENJADWALAN BERHASIL 100%! 🎉');
  console.log('========================================================================\n');
}

if (process.argv[1]?.includes('deadlineAndSlotDiagnostics.test')) {
  runDeadlineAndSlotDiagnosticsTests();
}
