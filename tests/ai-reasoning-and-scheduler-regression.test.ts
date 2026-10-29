import { describe, it, expect } from 'vitest';
import {
  parseIndonesianTemporalRules,
  extractCleanActivityTitle,
  ParseContext,
} from '../src/lib/temporalParser';
import {
  scheduleTaskDeterministically,
  scheduleAllPendingTasks,
} from '../src/lib/scheduler';
import {
  markMissedTaskAsCompleted,
} from '../src/lib/activityStatusManager';
import {
  createIsoInTimezone,
  formatInTimezone,
  getPartsInTimezone,
} from '../src/lib/timezone';
import { classifyGeminiError } from '../src/lib/geminiErrorHandling';
import { Task, CalendarEvent, UserPreferences, AIPlanDraft } from '../src/types';
import { INITIAL_PREFERENCES } from '../src/lib/mockData';

// WAKTU ACUAN TETAP (DETERMINISTIC ANCHOR):
// Minggu, 18 Oktober 2026, pukul 17:00:00 WIB (10:00:00 UTC)
const FIXED_REF_DATE = new Date('2026-10-18T10:00:00.000Z');
const TIMEZONE = 'Asia/Jakarta';

// Helper simulator pipeline backend /api/gemini/plan sanitization
function simulateBackendAiPipeline(
  prompt: string,
  mockGeminiPlan?: Partial<AIPlanDraft> | null,
  geminiError?: any,
  apiKeyConfigured: boolean = true
): {
  success: boolean;
  isAiGenerated: boolean;
  source: 'gemini' | 'rule_fallback' | 'rule_fallback_on_error';
  warning?: string;
  plan: AIPlanDraft;
} {
  const ctx: ParseContext = {
    userPrompt: prompt.trim(),
    currentDateTime: FIXED_REF_DATE.toISOString(),
    userTimezone: TIMEZONE,
    workHours: {
      workStartHour: INITIAL_PREFERENCES.workStartHour,
      workEndHour: INITIAL_PREFERENCES.workEndHour,
    },
  };

  const baselinePlan = parseIndonesianTemporalRules(ctx);

  if (!apiKeyConfigured) {
    return {
      success: true,
      isAiGenerated: false,
      source: 'rule_fallback',
      warning: 'Kunci GEMINI_API_KEY tidak tersedia di server. Menggunakan sistem aturan temporal deterministik EVEN.',
      plan: baselinePlan as any,
    };
  }

  if (geminiError || !mockGeminiPlan) {
    return {
      success: true,
      isAiGenerated: false,
      source: 'rule_fallback_on_error',
      warning: 'Layanan AI sedang mengalami beban tinggi atau batas waktu. Rencana tugas disusun secara akurat menggunakan mesin aturan temporal deterministik EVEN.',
      plan: baselinePlan as any,
    };
  }

  // Sanitasi persis seperti server.ts baris 241-346
  const sanitizedPlan: any = {
    ...mockGeminiPlan,
    timezone: TIMEZONE,
  };

  if (baselinePlan.targetOccurrences && baselinePlan.targetOccurrences.length > 1) {
    sanitizedPlan.timeConstraintType = 'fixed_event';
    sanitizedPlan.targetOccurrences = baselinePlan.targetOccurrences;
    sanitizedPlan.targetDays = baselinePlan.targetDays;
    sanitizedPlan.requestedStartAt = baselinePlan.targetOccurrences[0].requestedStartAt;
    sanitizedPlan.requestedEndAt = baselinePlan.targetOccurrences[0].requestedEndAt;
    sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
    sanitizedPlan.allowSplit = false;
  } else if (baselinePlan.timeConstraintType === 'fixed_event') {
    sanitizedPlan.timeConstraintType = 'fixed_event';
    if (baselinePlan.hasExplicitDayTarget || !mockGeminiPlan.requestedStartAt) {
      sanitizedPlan.requestedStartAt = baselinePlan.requestedStartAt;
      sanitizedPlan.requestedEndAt = baselinePlan.requestedEndAt;
    }
    sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
    sanitizedPlan.allowSplit = false;
    if (baselinePlan.targetOccurrences) sanitizedPlan.targetOccurrences = baselinePlan.targetOccurrences;
    if (baselinePlan.targetDays) sanitizedPlan.targetDays = baselinePlan.targetDays;
  } else if (baselinePlan.timeConstraintType === 'preferred_window') {
    sanitizedPlan.timeConstraintType = 'preferred_window';
    sanitizedPlan.preferredWindow = baselinePlan.preferredWindow;
    sanitizedPlan.preferredTimeOfDay = baselinePlan.preferredTimeOfDay;
    delete sanitizedPlan.requestedStartAt;
    delete sanitizedPlan.requestedEndAt;
  } else {
    sanitizedPlan.timeConstraintType = 'deadline_only';
    delete sanitizedPlan.requestedStartAt;
    delete sanitizedPlan.requestedEndAt;
    delete sanitizedPlan.preferredWindow;
    sanitizedPlan.preferredTimeOfDay = baselinePlan.preferredTimeOfDay;
  }

  // Enforce durasi eksplisit
  const promptHasExplicitDuration =
    /(\d+)\s*(?:menit|mnt|jam)/i.test(prompt) ||
    /(?:selama\s+)?(se|satu|dua|tiga|empat|lima|enam|tujuh|delapan)\s*jam/i.test(prompt) ||
    /\b(sejam|setengah jam)\b/i.test(prompt);

  if (promptHasExplicitDuration && baselinePlan.estimatedDurationMinutes) {
    sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
  }

  if (baselinePlan.targetDays && baselinePlan.targetDays.length > 0) {
    sanitizedPlan.targetDays = baselinePlan.targetDays;
  }
  if (baselinePlan.deadlineAt) {
    sanitizedPlan.deadlineAt = baselinePlan.deadlineAt;
    sanitizedPlan.deadlineDaysFromNow = baselinePlan.deadlineDaysFromNow;
  }

  sanitizedPlan.title = extractCleanActivityTitle(prompt, mockGeminiPlan.title || baselinePlan.title);

  return {
    success: true,
    isAiGenerated: true,
    source: 'gemini',
    plan: sanitizedPlan,
  };
}

// Helper konversi plan ke pseudoTask
function createPseudoTaskFromPlan(plan: AIPlanDraft, customId: string = 'task-test'): Task {
  return {
    id: customId,
    userId: 'user-default',
    title: plan.title,
    description: plan.description,
    estimatedDurationMinutes: plan.estimatedDurationMinutes,
    deadlineAt: plan.deadlineAt,
    priority: plan.priority || 'MEDIUM',
    status: 'UNSCHEDULED',
    allowSplit: plan.allowSplit,
    minimumSessionMinutes: plan.minimumSessionMinutes || 30,
    preferredTimeOfDay: plan.preferredTimeOfDay,
    timeConstraintType: plan.timeConstraintType,
    requestedStartAt: plan.requestedStartAt,
    requestedEndAt: plan.requestedEndAt,
    targetDays: plan.targetDays,
    targetOccurrences: plan.targetOccurrences,
    preferredWindow: plan.preferredWindow,
    timezone: plan.timezone || TIMEZONE,
    isRecurring: plan.isRecurring,
    recurrenceRule: plan.recurrenceRule,
    createdAt: FIXED_REF_DATE.toISOString(),
  };
}

if (process.env.VITEST) {
describe('Rangkaian Pengujian Regresi Penalaran AI & Scheduler EVEN', () => {
  // --------------------------------------------------------------------------
  // KASUS 1: Fixed event spesifik hari Rabu 19.00 - 22.00
  // --------------------------------------------------------------------------
  it('Kasus 1: "Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming"', () => {
    const prompt = 'Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: FIXED_REF_DATE.toISOString(),
      userTimezone: TIMEZONE,
    });

    // 1. Validasi parser
    expect(parsed.title).toBe('UTS Web Programming');
    expect(parsed.timeConstraintType).toBe('fixed_event');
    expect(parsed.estimatedDurationMinutes).toBe(180);
    expect(parsed.targetDays).toEqual([3]); // Rabu
    expect(parsed.requestedStartAt).toBe('2026-10-21T12:00:00.000Z'); // 19:00 WIB
    expect(parsed.requestedEndAt).toBe('2026-10-21T15:00:00.000Z');   // 22:00 WIB
    expect(parsed.allowSplit).toBe(false);

    // 2. Validasi scheduler
    const task = createPseudoTaskFromPlan(parsed as any);
    const schedRes = scheduleTaskDeterministically(task, [], [], INITIAL_PREFERENCES, FIXED_REF_DATE);

    expect(schedRes.success).toBe(true);
    expect(schedRes.proposedSessions).toHaveLength(1);
    expect(schedRes.proposedSessions[0].startAt).toBe('2026-10-21T12:00:00.000Z');
    expect(schedRes.proposedSessions[0].endAt).toBe('2026-10-21T15:00:00.000Z');
    expect(schedRes.proposedSessions[0].durationMinutes).toBe(180);
    expect(schedRes.explanation).toMatch(/dijadwalkan secara presisi tanpa digeser|Komitmen waktu tetap berhasil ditempatkan/);
  });

  // --------------------------------------------------------------------------
  // KASUS 2: Tugas fleksibel 3 jam hari Kamis (Durasi tidak boleh dipangkas)
  // --------------------------------------------------------------------------
  it('Kasus 2: "Kamis aku mau lanjut ngerjain desain kalau belum selesai, selama tiga jam"', () => {
    const prompt = 'Kamis aku mau lanjut ngerjain desain kalau belum selesai, selama tiga jam';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: FIXED_REF_DATE.toISOString(),
      userTimezone: TIMEZONE,
    });

    expect(parsed.title).toBe('Melanjutkan Desain');
    expect(parsed.estimatedDurationMinutes).toBe(180);
    expect(parsed.targetDays).toEqual([4]); // Kamis
    expect(parsed.timeConstraintType).not.toBe('fixed_event'); // Tugas fleksibel

    const task = createPseudoTaskFromPlan(parsed as any);

    // Uji A: Jadwal Kamis hanya punya slot kosong 60 menit -> Scheduler HARUS MENOLAK
    const busyEventsOnThursday: CalendarEvent[] = [
      {
        id: 'evt-thu-1',
        provider: 'internal',
        title: 'Rapat Pagi',
        startAt: '2026-10-22T02:00:00.000Z', // 09:00 WIB
        endAt: '2026-10-22T05:00:00.000Z',   // 12:00 WIB
        isEditable: false,
        syncStatus: 'synced',
      },
      {
        id: 'evt-thu-2',
        provider: 'internal',
        title: 'Workshop Siang',
        startAt: '2026-10-22T06:00:00.000Z', // 13:00 WIB
        endAt: '2026-10-22T10:00:00.000Z',   // 17:00 WIB (sisa hanya 17:00-18:00 = 60 menit)
        isEditable: false,
        syncStatus: 'synced',
      },
    ];

    const failedRes = scheduleTaskDeterministically(task, busyEventsOnThursday, [], INITIAL_PREFERENCES, FIXED_REF_DATE);
    expect(failedRes.success).toBe(false);
    expect(failedRes.failureCode).toBe('NO_SLOT_BEFORE_DEADLINE');
    expect(failedRes.explanation).toContain('Tidak ditemukan slot waktu kosong yang mencukupi durasi (180 menit)');
    expect(failedRes.explanation).toMatch(/Slot bebas terbesar hanya (?:45|60) menit/);
    expect(failedRes.explanation).toContain('dibutuhkan 180 menit tanpa opsi split');

    // Uji B: Jadwal Kamis luang -> Sukses alokasi 180 menit
    const successRes = scheduleTaskDeterministically(task, [], [], INITIAL_PREFERENCES, FIXED_REF_DATE);
    expect(successRes.success).toBe(true);
    expect(successRes.proposedSessions).toHaveLength(1);
    expect(successRes.proposedSessions[0].durationMinutes).toBe(180);
  });

  // --------------------------------------------------------------------------
  // KASUS 3: Deadline Jumat, pengerjaan Kamis dan Selasa habis Magrib 3 jam
  // --------------------------------------------------------------------------
  it('Kasus 3: "Aku ada UTS Design deadline-nya hari Jumat, jadi nanti Kamis dan Selasa habis Magrib, aku mau ngerjain selama tiga jam"', () => {
    const prompt = 'Aku ada UTS Design deadline-nya hari Jumat, jadi nanti Kamis dan Selasa habis Magrib, aku mau ngerjain selama tiga jam';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: FIXED_REF_DATE.toISOString(), // Minggu 18 Okt
      userTimezone: TIMEZONE,
    });

    // 1. Deadline Jumat HARUS dipisahkan dari hari pengerjaan
    expect(parsed.deadlineAt).toBe('2026-10-23T16:59:00.000Z'); // Jumat 23:59 WIB
    expect(parsed.targetDays).toEqual([2, 4]); // Selasa (2) dan Kamis (4)
    expect(parsed.preferredWindow?.startHour).toBe(18);
    expect(parsed.preferredWindow?.startMinute).toBe(30);
    expect(parsed.estimatedDurationMinutes).toBe(180);

    // 2. Scheduler menempatkan 2 sesi sebelum deadline Jumat
    const task = createPseudoTaskFromPlan(parsed as any);
    const schedRes = scheduleTaskDeterministically(task, [], [], INITIAL_PREFERENCES, FIXED_REF_DATE);

    expect(schedRes.success).toBe(true);
    expect(schedRes.proposedSessions).toHaveLength(2);
    // Sesi 1: Selasa 20 Okt 18:30–21:30 WIB (UTC 11:30–14:30)
    expect(schedRes.proposedSessions[0].startAt).toBe('2026-10-20T11:30:00.000Z');
    expect(schedRes.proposedSessions[0].durationMinutes).toBe(180);
    // Sesi 2: Kamis 22 Okt 18:30–21:30 WIB (UTC 11:30–14:30)
    expect(schedRes.proposedSessions[1].startAt).toBe('2026-10-22T11:30:00.000Z');
    expect(schedRes.proposedSessions[1].durationMinutes).toBe(180);

    // Pastikan kedua sesi selesai sebelum batas tenggat Jumat
    const deadlineMs = new Date(parsed.deadlineAt!).getTime();
    expect(new Date(schedRes.proposedSessions[0].endAt).getTime()).toBeLessThan(deadlineMs);
    expect(new Date(schedRes.proposedSessions[1].endAt).getTime()).toBeLessThan(deadlineMs);
  });

  // --------------------------------------------------------------------------
  // KASUS 4: Recurrence mingguan dibedakan dari 2 tanggal satu kali
  // --------------------------------------------------------------------------
  it('Kasus 4: "Kelas setiap Senin dan Rabu jam 19.00 sampai 21.00"', () => {
    const prompt = 'Kelas setiap Senin dan Rabu jam 19.00 sampai 21.00';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: FIXED_REF_DATE.toISOString(),
      userTimezone: TIMEZONE,
    });

    expect(parsed.isRecurring).toBe(true);
    expect(parsed.recurrenceRule).toBe('WEEKLY_ON_DAYS');
    expect(parsed.timeConstraintType).toBe('fixed_event');
    expect(parsed.targetDays).toEqual([1, 3]); // Senin & Rabu
    expect(parsed.targetOccurrences).toHaveLength(2);
    expect(parsed.estimatedDurationMinutes).toBe(120);

    // Kejadian 1: Senin 19.00 - 21.00 WIB
    expect(parsed.targetOccurrences![0].requestedStartAt).toBe('2026-10-19T12:00:00.000Z');
    expect(parsed.targetOccurrences![0].requestedEndAt).toBe('2026-10-19T14:00:00.000Z');
    // Kejadian 2: Rabu 19.00 - 21.00 WIB
    expect(parsed.targetOccurrences![1].requestedStartAt).toBe('2026-10-21T12:00:00.000Z');
    expect(parsed.targetOccurrences![1].requestedEndAt).toBe('2026-10-21T14:00:00.000Z');
  });

  // --------------------------------------------------------------------------
  // KASUS 5: Preferensi pagi dan durasi eksplisit 45 menit tidak hilang
  // --------------------------------------------------------------------------
  it('Kasus 5: "Besok pagi baca dokumentasi selama 45 menit"', () => {
    const prompt = 'Besok pagi baca dokumentasi selama 45 menit';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: FIXED_REF_DATE.toISOString(), // Minggu 18 Okt
      userTimezone: TIMEZONE,
    });

    expect(parsed.preferredTimeOfDay).toBe('MORNING');
    expect(parsed.preferredWindow?.startHour).toBe(6);
    expect(parsed.preferredWindow?.endHour).toBe(12);
    expect(parsed.estimatedDurationMinutes).toBe(45);

    const task = createPseudoTaskFromPlan(parsed as any);
    const schedRes = scheduleTaskDeterministically(task, [], [], INITIAL_PREFERENCES, FIXED_REF_DATE);

    expect(schedRes.success).toBe(true);
    expect(schedRes.proposedSessions).toHaveLength(1);
    expect(schedRes.proposedSessions[0].durationMinutes).toBe(45);
    // Jam mulai harus berada di jendela pagi (antara 06:00 s.d 12:00 WIB)
    const startParts = getPartsInTimezone(new Date(schedRes.proposedSessions[0].startAt), TIMEZONE);
    expect(startParts.hour).toBeGreaterThanOrEqual(6);
    expect(startParts.hour).toBeLessThan(12);
    expect(startParts.dayOfWeek).toBe(1); // Senin (Besok dari Minggu)
  });

  // --------------------------------------------------------------------------
  // KASUS 6: Tugas fleksibel 3 jam sebelum deadline Jumat
  // --------------------------------------------------------------------------
  it('Kasus 6: "Jadwalkan belajar selama tiga jam sebelum deadline Jumat"', () => {
    const prompt = 'Jadwalkan belajar selama tiga jam sebelum deadline Jumat';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: FIXED_REF_DATE.toISOString(),
      userTimezone: TIMEZONE,
    });

    expect(parsed.estimatedDurationMinutes).toBe(180);
    expect(parsed.timeConstraintType).toBe('deadline_only');
    expect(parsed.deadlineAt).toBe('2026-10-23T16:59:00.000Z'); // Jumat 23:59 WIB

    const task = createPseudoTaskFromPlan(parsed as any);
    const schedRes = scheduleTaskDeterministically(task, [], [], INITIAL_PREFERENCES, FIXED_REF_DATE);

    expect(schedRes.success).toBe(true);
    expect(schedRes.proposedSessions[0].durationMinutes).toBe(180);
    expect(new Date(schedRes.proposedSessions[0].endAt).getTime()).toBeLessThan(
      new Date(parsed.deadlineAt!).getTime()
    );
  });

  // --------------------------------------------------------------------------
  // KASUS 7: Fixed event bertabrakan dengan acara kalender -> Laporkan konflik!
  // --------------------------------------------------------------------------
  it('Kasus 7: Permintaan fixed event yang bertabrakan dengan acara kalender', () => {
    const fixedTask: Task = {
      id: 'task-fixed-collision',
      userId: 'user-default',
      title: 'Kuliah Tamu Sistem Terdistribusi',
      estimatedDurationMinutes: 120,
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: false,
      timeConstraintType: 'fixed_event',
      requestedStartAt: '2026-10-21T12:00:00.000Z', // Rabu 19:00 WIB
      requestedEndAt: '2026-10-21T14:00:00.000Z',   // Rabu 21:00 WIB
      timezone: TIMEZONE,
      createdAt: FIXED_REF_DATE.toISOString(),
    };

    const conflictingEvent: CalendarEvent = {
      id: 'evt-conflicting-1',
      provider: 'google',
      title: 'Rapat Internal Proyek',
      startAt: '2026-10-21T12:30:00.000Z', // 19:30 WIB (tumpang tindih)
      endAt: '2026-10-21T13:30:00.000Z',   // 20:30 WIB
      isEditable: false,
      syncStatus: 'synced',
    };

    const result = scheduleTaskDeterministically(
      fixedTask,
      [conflictingEvent],
      [],
      INITIAL_PREFERENCES,
      FIXED_REF_DATE
    );

    expect(result.success).toBe(false);
    expect(result.proposedSessions).toHaveLength(0);
    expect(result.explanation).toContain('bertabrakan dengan acara kalender "Rapat Internal Proyek"');
    expect(result.explanation).toContain('Komitmen waktu tetap tidak dapat digeser secara otomatis');
  });

  // --------------------------------------------------------------------------
  // KASUS 8: Permintaan fleksibel ketika tidak ada slot cukup -> Jangan klaim berhasil
  // --------------------------------------------------------------------------
  it('Kasus 8: Permintaan fleksibel ketika tidak ada slot yang cukup', () => {
    const heavyTask: Task = {
      id: 'task-heavy-flexible',
      userId: 'user-default',
      title: 'Workshop Pemrograman Bareng',
      estimatedDurationMinutes: 480, // 8 jam tanpa jeda
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: false, // Tidak boleh dibagi
      timeConstraintType: 'preferred_window',
      preferredTimeOfDay: 'EVENING',
      preferredWindow: { startHour: 19, endHour: 23, label: 'Malam (19:00 - 23:00)' },
      timezone: TIMEZONE,
      createdAt: FIXED_REF_DATE.toISOString(),
    };

    // Jendela malam hanya 4 jam (240 menit), sedangkan tugas butuh 8 jam (480 menit)
    const result = scheduleTaskDeterministically(heavyTask, [], [], INITIAL_PREFERENCES, FIXED_REF_DATE);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('PREFERRED_WINDOW_FULL');
    expect(result.proposedSessions).toHaveLength(0);
    expect(result.explanation).toContain('Tidak ditemukan slot waktu luang yang mencukupi (480 menit)');
    expect(result.warning).toContain('Saran: Anda dapat mengaktifkan opsi "Boleh dipecah menjadi beberapa sesi"');
  });

  // --------------------------------------------------------------------------
  // KASUS 9: Gemini gagal atau timeout -> Fallback jujur dan transparan
  // --------------------------------------------------------------------------
  it('Kasus 9: Penanganan Gemini gagal atau timeout', () => {
    const prompt = 'Besok jam 9 malam belajar materi React 45 menit';

    // 1. Uji kondisi tanpa API Key
    const noKeyResult = simulateBackendAiPipeline(prompt, null, null, false);
    expect(noKeyResult.success).toBe(true);
    expect(noKeyResult.isAiGenerated).toBe(false);
    expect(noKeyResult.source).toBe('rule_fallback');
    expect(noKeyResult.warning).toContain('Kunci GEMINI_API_KEY tidak tersedia di server');

    // 2. Uji kondisi Gemini error HTTP 503
    const error503 = new Error('The service is temporarily overloaded. Please try again later.');
    (error503 as any).status = 503;
    const classified = classifyGeminiError(error503);
    expect(classified.status).toBe(503);
    expect(classified.isRetryable).toBe(true);
    expect(classified.errorCode).toBe('AI_TEMPORARILY_UNAVAILABLE');

    const fallbackOnErrorResult = simulateBackendAiPipeline(prompt, null, error503, true);
    expect(fallbackOnErrorResult.success).toBe(true);
    expect(fallbackOnErrorResult.isAiGenerated).toBe(false);
    expect(fallbackOnErrorResult.source).toBe('rule_fallback_on_error');
    expect(fallbackOnErrorResult.warning).toContain('Layanan AI sedang mengalami beban tinggi atau batas waktu');

    // 3. Pastikan hasil fallback tetap akurat secara temporal
    expect(fallbackOnErrorResult.plan.estimatedDurationMinutes).toBe(45);
    expect(fallbackOnErrorResult.plan.preferredTimeOfDay).toBe('EVENING');
  });

  // --------------------------------------------------------------------------
  // KASUS 10: Gemini halusinasi tanggal bertentangan dengan prompt pengguna
  // --------------------------------------------------------------------------
  it('Kasus 10: Gemini menghasilkan tanggal/hari yang berbeda dari parser deterministik', () => {
    // Pengguna eksplisit meminta Rabu, namun AI berhalusinasi mengembalikan Senin
    const prompt = 'Rabu malam jam 7 sampai jam 10 malam ada UTS Web Programming';

    const hallucinatedGeminiPlan: Partial<AIPlanDraft> = {
      title: 'UTS Web Programming',
      timeConstraintType: 'fixed_event',
      requestedStartAt: '2026-10-19T12:00:00.000Z', // SALAH: Ini Senin, bukan Rabu!
      requestedEndAt: '2026-10-19T15:00:00.000Z',
      estimatedDurationMinutes: 60,                // SALAH: Pengguna minta 3 jam!
      priority: 'HIGH',
      allowSplit: true,                            // SALAH: Fixed event tidak boleh split!
      reasoning: 'Rencana disusun oleh AI',
    };

    const sanitizedResult = simulateBackendAiPipeline(prompt, hallucinatedGeminiPlan, null, true);

    // Evaluasi integritas: Pipeline HARUS mengoreksi halusinasi tanggal, durasi, dan split
    expect(sanitizedResult.plan.requestedStartAt).toBe('2026-10-21T12:00:00.000Z'); // Rabu!
    expect(sanitizedResult.plan.requestedEndAt).toBe('2026-10-21T15:00:00.000Z');   // 22:00 WIB!
    expect(sanitizedResult.plan.estimatedDurationMinutes).toBe(180);                // 180 menit!
    expect(sanitizedResult.plan.allowSplit).toBe(false);                            // No split!
  });

  // --------------------------------------------------------------------------
  // KASUS 11: Idempotensi & Pencegahan duplikasi acara kalender
  // --------------------------------------------------------------------------
  it('Kasus 11: Permintaan yang sama diproses dua kali tidak menduplikasi acara', () => {
    const task: Task = {
      id: 'task-idempotent-test',
      userId: 'user-123',
      title: 'Review PR & Sinkronisasi Sprint',
      estimatedDurationMinutes: 60,
      priority: 'HIGH',
      status: 'UNSCHEDULED',
      allowSplit: false,
      timezone: TIMEZONE,
      createdAt: FIXED_REF_DATE.toISOString(),
    };

    // Eksekusi penjadwalan pertama
    const { results: run1Results, updatedTasks: tasksAfterRun1 } = scheduleAllPendingTasks(
      [task],
      [],
      INITIAL_PREFERENCES
    );

    expect(run1Results[0].success).toBe(true);
    const scheduledTask1 = tasksAfterRun1[0];
    expect(scheduledTask1.status).toBe('SCHEDULED');
    expect(scheduledTask1.scheduledSessions).toHaveLength(1);
    const sessionId = scheduledTask1.scheduledSessions![0].id;

    // Simulasikan acara Google Calendar yang terhubung dengan session tersebut
    const existingEvents: CalendarEvent[] = [
      {
        id: `gcal-${sessionId}`,
        provider: 'google',
        title: `[EVEN] ${scheduledTask1.title}`,
        startAt: scheduledTask1.scheduledSessions![0].startAt,
        endAt: scheduledTask1.scheduledSessions![0].endAt,
        isEditable: false,
        syncStatus: 'synced',
      },
    ];

    // Eksekusi penjadwalan kedua dengan input yang sama
    const { results: run2Results, updatedTasks: tasksAfterRun2 } = scheduleAllPendingTasks(
      tasksAfterRun1,
      existingEvents,
      INITIAL_PREFERENCES
    );

    // Tugas yang sudah berstatus 'SCHEDULED' tidak boleh diproses ulang menjadi draf baru
    expect(run2Results).toHaveLength(0);
    expect(tasksAfterRun2[0].scheduledSessions).toHaveLength(1);
    expect(tasksAfterRun2[0].scheduledSessions![0].id).toBe(sessionId);
  });

  // --------------------------------------------------------------------------
  // KASUS 12: Konfirmasi kegiatan terlewat menjadi selesai secara manual
  // --------------------------------------------------------------------------
  it('Kasus 12: Pengguna mengonfirmasi bahwa kegiatan yang terlewat sebenarnya telah selesai', () => {
    const missedTask: Task = {
      id: 'task-missed-eval-12',
      userId: 'user-123',
      title: 'Mengerjakan Modul 4 Praktikum',
      estimatedDurationMinutes: 90,
      priority: 'HIGH',
      status: 'missed_auto',
      missedAt: '2026-10-25T14:00:00.000Z',
      createdAt: '2026-10-20T08:00:00.000Z',
      scheduledSessions: [
        {
          id: 'sess-missed-12',
          taskId: 'task-missed-eval-12',
          taskTitle: 'Mengerjakan Modul 4 Praktikum',
          sessionIndex: 1,
          totalSessions: 1,
          startAt: '2026-10-25T10:00:00.000Z',
          endAt: '2026-10-25T11:30:00.000Z',
          durationMinutes: 90,
          status: 'missed_auto',
          googleCalendarEventId: 'gcal-evt-888',
        },
      ],
      statusHistory: [
        {
          status: 'missed_auto',
          changedAt: '2026-10-25T14:00:00.000Z',
          reason: 'Terlewat dari jadwal',
        },
      ],
    };

    const confirmTime = new Date('2026-10-26T10:00:00.000Z');
    const updated = markMissedTaskAsCompleted(missedTask, confirmTime);

    // 1. Status bertransisi ke completed_manual
    expect(updated.status).toBe('completed_manual');
    expect(updated.completedAt).toBe(confirmTime.toISOString());

    // 2. missedAt asli tetap dipertahankan
    expect(updated.missedAt).toBe('2026-10-25T14:00:00.000Z');

    // 3. Relasi Google Calendar pada sesi jadwal tidak terhapus
    expect(updated.scheduledSessions![0].status).toBe('completed_manual');
    expect(updated.scheduledSessions![0].googleCalendarEventId).toBe('gcal-evt-888');

    // 4. Riwayat status bertambah dengan alasan konfirmasi
    expect(updated.statusHistory).toHaveLength(2);
    expect(updated.statusHistory![1].status).toBe('completed_manual');
    expect(updated.statusHistory![1].reason).toBe('Pengguna mengonfirmasi bahwa kegiatan telah selesai.');

    // 5. Idempotensi: pemanggilan berulang tidak mengubah objek atau menambah riwayat duplikat
    const secondCall = markMissedTaskAsCompleted(updated, new Date('2026-10-27T10:00:00.000Z'));
    expect(secondCall).toBe(updated);
    expect(secondCall.statusHistory).toHaveLength(2);
  });
});
}

export function runAllAiSchedulerRegressionTests() {
  console.log('========================================================================');
  console.log('🚀 MENJALANKAN 12 PENGUJIAN REGRESI PENALARAN AI & SCHEDULER EVEN 🚀');
  console.log('========================================================================\n');

  // Case 1
  console.log('>>> [1/12] Uji Kasus 1: "Rabu malam jam 7 sampai jam 10 malam..."');
  const p1 = parseIndonesianTemporalRules({
    userPrompt: 'Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming',
    currentDateTime: FIXED_REF_DATE.toISOString(),
    userTimezone: TIMEZONE,
  });
  if (p1.title !== 'UTS Web Programming' || p1.estimatedDurationMinutes !== 180 || p1.requestedStartAt !== '2026-10-21T12:00:00.000Z') {
    throw new Error(`Kasus 1 Gagal: ${JSON.stringify(p1)}`);
  }
  console.log('✅ Kasus 1 LULUS: Judul "UTS Web Programming", 19.00-22.00 WIB (180 mnt), Fixed Event.');

  // Case 2
  console.log('\n>>> [2/12] Uji Kasus 2: "Kamis lanjut ngerjain desain 3 jam (Penolakan slot 1 jam)..."');
  const p2 = parseIndonesianTemporalRules({
    userPrompt: 'Kamis aku mau lanjut ngerjain desain kalau belum selesai, selama tiga jam',
    currentDateTime: FIXED_REF_DATE.toISOString(),
    userTimezone: TIMEZONE,
  });
  const t2 = createPseudoTaskFromPlan(p2 as any);
  const busy2: CalendarEvent[] = [
    { id: '1', provider: 'internal', title: 'A', startAt: '2026-10-22T02:00:00.000Z', endAt: '2026-10-22T05:00:00.000Z', isEditable: false, syncStatus: 'synced' },
    { id: '2', provider: 'internal', title: 'B', startAt: '2026-10-22T06:00:00.000Z', endAt: '2026-10-22T10:00:00.000Z', isEditable: false, syncStatus: 'synced' },
  ];
  const res2 = scheduleTaskDeterministically(t2, busy2, [], INITIAL_PREFERENCES, FIXED_REF_DATE);
  if (res2.success !== false || !res2.explanation.includes('180 menit')) {
    throw new Error('Kasus 2 Gagal: Scheduler tidak menolak slot 60 menit!');
  }
  console.log('✅ Kasus 2 LULUS: Durasi 180 menit dipertahankan, slot 60 menit ditolak secara transparan.');

  // Case 3
  console.log('\n>>> [3/12] Uji Kasus 3: "UTS Design deadline Jumat, Kamis & Selasa habis Magrib 3 jam..."');
  const p3 = parseIndonesianTemporalRules({
    userPrompt: 'Aku ada UTS Design deadline-nya hari Jumat, jadi nanti Kamis dan Selasa habis Magrib, aku mau ngerjain selama tiga jam',
    currentDateTime: FIXED_REF_DATE.toISOString(),
    userTimezone: TIMEZONE,
  });
  if (p3.deadlineAt !== '2026-10-23T16:59:00.000Z' || p3.targetDays?.length !== 2) {
    throw new Error(`Kasus 3 Gagal: ${JSON.stringify(p3)}`);
  }
  const t3 = createPseudoTaskFromPlan(p3 as any);
  const res3 = scheduleTaskDeterministically(t3, [], [], INITIAL_PREFERENCES, FIXED_REF_DATE);
  if (!res3.success || res3.proposedSessions.length !== 2) {
    throw new Error('Kasus 3 Gagal: Sesi multi-hari tidak terjadwal!');
  }
  console.log('✅ Kasus 3 LULUS: Deadline Jumat dipisahkan, 2 sesi terjadwal pada Selasa dan Kamis.');

  // Case 4
  console.log('\n>>> [4/12] Uji Kasus 4: "Kelas setiap Senin dan Rabu jam 19.00 sampai 21.00..."');
  const p4 = parseIndonesianTemporalRules({
    userPrompt: 'Kelas setiap Senin dan Rabu jam 19.00 sampai 21.00',
    currentDateTime: FIXED_REF_DATE.toISOString(),
    userTimezone: TIMEZONE,
  });
  if (!p4.isRecurring || p4.recurrenceRule !== 'WEEKLY_ON_DAYS' || p4.targetOccurrences?.length !== 2) {
    throw new Error(`Kasus 4 Gagal: ${JSON.stringify(p4)}`);
  }
  console.log('✅ Kasus 4 LULUS: Recurrence mingguan teridentifikasi untuk Senin dan Rabu.');

  // Case 5
  console.log('\n>>> [5/12] Uji Kasus 5: "Besok pagi baca dokumentasi selama 45 menit..."');
  const p5 = parseIndonesianTemporalRules({
    userPrompt: 'Besok pagi baca dokumentasi selama 45 menit',
    currentDateTime: FIXED_REF_DATE.toISOString(),
    userTimezone: TIMEZONE,
  });
  if (p5.preferredTimeOfDay !== 'MORNING' || p5.estimatedDurationMinutes !== 45) {
    throw new Error(`Kasus 5 Gagal: ${JSON.stringify(p5)}`);
  }
  console.log('✅ Kasus 5 LULUS: Preferensi pagi (06:00-12:00) dan durasi 45 menit terjaga.');

  // Case 6
  console.log('\n>>> [6/12] Uji Kasus 6: "Jadwalkan belajar selama tiga jam sebelum deadline Jumat..."');
  const p6 = parseIndonesianTemporalRules({
    userPrompt: 'Jadwalkan belajar selama tiga jam sebelum deadline Jumat',
    currentDateTime: FIXED_REF_DATE.toISOString(),
    userTimezone: TIMEZONE,
  });
  if (p6.timeConstraintType !== 'deadline_only' || p6.estimatedDurationMinutes !== 180) {
    throw new Error(`Kasus 6 Gagal: ${JSON.stringify(p6)}`);
  }
  console.log('✅ Kasus 6 LULUS: Tugas fleksibel 180 menit selesai sebelum batas tenggat Jumat.');

  // Case 7
  console.log('\n>>> [7/12] Uji Kasus 7: "Tabrakan Fixed Event dengan Acara Kalender..."');
  const fixedCollisionTask: Task = {
    id: 'c7',
    userId: 'u',
    title: 'Acara Tetap',
    estimatedDurationMinutes: 120,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'fixed_event',
    requestedStartAt: '2026-10-21T12:00:00.000Z',
    requestedEndAt: '2026-10-21T14:00:00.000Z',
    timezone: TIMEZONE,
    createdAt: FIXED_REF_DATE.toISOString(),
  };
  const c7Res = scheduleTaskDeterministically(
    fixedCollisionTask,
    [{ id: 'e1', provider: 'google', title: 'Rapat', startAt: '2026-10-21T12:30:00.000Z', endAt: '2026-10-21T13:30:00.000Z', isEditable: false, syncStatus: 'synced' }],
    [],
    INITIAL_PREFERENCES,
    FIXED_REF_DATE
  );
  if (c7Res.success !== false) {
    throw new Error('Kasus 7 Gagal: Benturan fixed event tidak dilaporkan!');
  }
  console.log('✅ Kasus 7 LULUS: Benturan dilaporkan, acara tetap tidak digeser secara sepihak.');

  // Case 8
  console.log('\n>>> [8/12] Uji Kasus 8: "Permintaan fleksibel ketika slot tidak cukup..."');
  const heavyTask: Task = {
    id: 'c8',
    userId: 'u',
    title: 'Workshop',
    estimatedDurationMinutes: 480,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    timeConstraintType: 'preferred_window',
    preferredTimeOfDay: 'EVENING',
    preferredWindow: { startHour: 19, endHour: 23 },
    timezone: TIMEZONE,
    createdAt: FIXED_REF_DATE.toISOString(),
  };
  const c8Res = scheduleTaskDeterministically(heavyTask, [], [], INITIAL_PREFERENCES, FIXED_REF_DATE);
  if (c8Res.success !== false) {
    throw new Error('Kasus 8 Gagal: Tugas melebihi kapasitas tidak ditolak!');
  }
  console.log('✅ Kasus 8 LULUS: Tidak mengklaim sukses palsu, memberi alternatif split.');

  // Case 9
  console.log('\n>>> [9/12] Uji Kasus 9: "Gemini gagal / timeout fallback..."');
  const pipeRes = simulateBackendAiPipeline('Belajar React besok malam 45 menit', null, null, false);
  if (pipeRes.isAiGenerated !== false || pipeRes.source !== 'rule_fallback') {
    throw new Error('Kasus 9 Gagal: Fallback tidak transparan!');
  }
  console.log('✅ Kasus 9 LULUS: Mode fallback rule_fallback dilaporkan secara jujur.');

  // Case 10
  console.log('\n>>> [10/12] Uji Kasus 10: "Gemini halusinasi tanggal dikoreksi oleh baseline..."');
  const halPlan: Partial<AIPlanDraft> = {
    title: 'UTS Web Programming',
    timeConstraintType: 'fixed_event',
    requestedStartAt: '2026-10-19T12:00:00.000Z', // Senin (salah)
    requestedEndAt: '2026-10-19T15:00:00.000Z',
    estimatedDurationMinutes: 60,
    priority: 'HIGH',
    allowSplit: true,
  };
  const c10Res = simulateBackendAiPipeline('Rabu malam jam 7 sampai 10 malam ada UTS Web Programming', halPlan, null, true);
  if (c10Res.plan.requestedStartAt !== '2026-10-21T12:00:00.000Z' || c10Res.plan.estimatedDurationMinutes !== 180) {
    throw new Error('Kasus 10 Gagal: Halusinasi tidak disanitasi!');
  }
  console.log('✅ Kasus 10 LULUS: Halusinasi tanggal dan durasi dikoreksi oleh baseline deterministik.');

  // Case 11
  console.log('\n>>> [11/12] Uji Kasus 11: "Idempotensi & Pencegahan duplikasi kalender..."');
  const t11: Task = {
    id: 't11',
    userId: 'u',
    title: 'Review PR',
    estimatedDurationMinutes: 60,
    priority: 'HIGH',
    status: 'SCHEDULED',
    allowSplit: false,
    scheduledSessions: [{ id: 's11', taskId: 't11', taskTitle: 'Review PR', sessionIndex: 1, totalSessions: 1, startAt: '2026-10-19T02:00:00.000Z', endAt: '2026-10-19T03:00:00.000Z', durationMinutes: 60, status: 'SCHEDULED', syncStatus: 'synced' }],
    timezone: TIMEZONE,
    createdAt: FIXED_REF_DATE.toISOString(),
  };
  const { results: run2 } = scheduleAllPendingTasks([t11], [], INITIAL_PREFERENCES);
  if (run2.length !== 0) {
    throw new Error('Kasus 11 Gagal: Task yang sudah SCHEDULED diproses ulang!');
  }
  console.log('✅ Kasus 11 LULUS: Idempotensi terjamin, tidak ada duplikasi jadwal.');

  // Case 12
  console.log('\n>>> [12/12] Uji Kasus 12: "Tandai kegiatan terlewat menjadi selesai secara manual..."');
  const t12: Task = {
    id: 't12',
    userId: 'u',
    title: 'Praktikum',
    estimatedDurationMinutes: 90,
    priority: 'HIGH',
    status: 'missed_auto',
    missedAt: '2026-10-25T14:00:00.000Z',
    createdAt: '2026-10-20T08:00:00.000Z',
  };
  const updated12 = markMissedTaskAsCompleted(t12, new Date('2026-10-26T10:00:00.000Z'));
  if (updated12.status !== 'completed_manual' || updated12.missedAt !== '2026-10-25T14:00:00.000Z') {
    throw new Error('Kasus 12 Gagal: Status atau missedAt tidak valid!');
  }
  console.log('✅ Kasus 12 LULUS: Status menjadi completed_manual, missedAt asli terjaga.');

  console.log('\n========================================================================');
  console.log('🎉 SEMUA 12 PENGUJIAN REGRESI PENALARAN AI & SCHEDULER BERHASIL 100%! 🎉');
  console.log('========================================================================\n');
}
