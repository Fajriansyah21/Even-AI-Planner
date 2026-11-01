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
import {
  getAvailableSplitOptions,
  formatPlanTargetDisplay,
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

  console.log('\n========================================================================');
  console.log('🎉 SELURUH PENGUJIAN DIAGNOSTIK TENGGAT & SLOT PENJADWALAN BERHASIL 100%! 🎉');
  console.log('========================================================================\n');
}

if (process.argv[1]?.includes('deadlineAndSlotDiagnostics.test')) {
  runDeadlineAndSlotDiagnosticsTests();
}
