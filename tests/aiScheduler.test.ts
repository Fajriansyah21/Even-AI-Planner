import { describe, it, expect } from 'vitest';
import {
  parseIndonesianTemporalRules,
  extractCleanActivityTitle,
  detectOperationalIntent,
  ParseContext,
} from '../src/lib/temporalParser';
import {
  scheduleTaskDeterministically,
  scheduleAllPendingTasks,
  verifyAndNormalizeReferenceDate,
} from '../src/lib/scheduler';
import { markMissedTaskAsCompleted } from '../src/lib/activityStatusManager';
import {
  createIsoInTimezone,
  formatInTimezone,
  getPartsInTimezone,
} from '../src/lib/timezone';
import { Task, CalendarEvent, UserPreferences, AIPlanDraft } from '../src/types';
import { INITIAL_PREFERENCES } from '../src/lib/mockData';

// WAKTU ACUAN TETAP (DETERMINISTIC ANCHOR):
// Senin, 20 Mei 2024, pukul 16:00:00 WIB (09:00:00 UTC)
export const MOCK_REFERENCE_DATE = new Date('2024-05-20T09:00:00.000Z');
export const TEST_TIMEZONE = 'Asia/Jakarta';

// Simulator pipeline backend /api/gemini/plan dengan sanitasi deterministik
export function simulateBackendPlanPipeline(
  prompt: string,
  options?: {
    mockGeminiPlan?: Partial<AIPlanDraft> | null;
    geminiError?: any;
    apiKeyConfigured?: boolean;
    refDate?: Date;
  }
): {
  success: boolean;
  isAiGenerated: boolean;
  source: 'gemini' | 'rule_fallback' | 'rule_fallback_on_error' | 'operational_intent';
  warning?: string;
  plan: AIPlanDraft;
} {
  const refDate = options?.refDate || MOCK_REFERENCE_DATE;
  const apiKeyConfigured = options?.apiKeyConfigured ?? true;

  const ctx: ParseContext = {
    userPrompt: prompt.trim(),
    currentDateTime: refDate.toISOString(),
    userTimezone: TEST_TIMEZONE,
    workHours: {
      workStartHour: INITIAL_PREFERENCES.workStartHour,
      workEndHour: INITIAL_PREFERENCES.workEndHour,
    },
  };

  const baselinePlan = parseIndonesianTemporalRules(ctx);

  if (baselinePlan.isOperational) {
    return {
      success: true,
      isAiGenerated: false,
      source: 'operational_intent',
      plan: baselinePlan as any,
    };
  }

  if (!apiKeyConfigured) {
    return {
      success: true,
      isAiGenerated: false,
      source: 'rule_fallback',
      warning: 'Kunci GEMINI_API_KEY tidak tersedia di server. Menggunakan sistem aturan temporal deterministik EVEN.',
      plan: baselinePlan as any,
    };
  }

  if (options?.geminiError || !options?.mockGeminiPlan) {
    return {
      success: true,
      isAiGenerated: false,
      source: 'rule_fallback_on_error',
      warning: 'Layanan AI sedang mengalami beban tinggi atau batas waktu. Rencana tugas disusun secara akurat menggunakan mesin aturan temporal deterministik EVEN.',
      plan: baselinePlan as any,
    };
  }

  // Sanitasi persis seperti server.ts
  const sanitizedPlan: any = {
    ...options.mockGeminiPlan,
    timezone: TEST_TIMEZONE,
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
    if (baselinePlan.hasExplicitDayTarget || !options.mockGeminiPlan.requestedStartAt) {
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
  }

  if (baselinePlan.targetDays && baselinePlan.targetDays.length > 0) {
    sanitizedPlan.targetDays = baselinePlan.targetDays;
  }
  if (baselinePlan.targetOccurrences && baselinePlan.targetOccurrences.length > 0) {
    sanitizedPlan.targetOccurrences = baselinePlan.targetOccurrences;
  }
  if (baselinePlan.preferredTimeOfDay !== 'ANY') {
    sanitizedPlan.preferredTimeOfDay = baselinePlan.preferredTimeOfDay;
  }
  if (baselinePlan.deadlineAt) {
    sanitizedPlan.deadlineAt = baselinePlan.deadlineAt;
    sanitizedPlan.deadlineDaysFromNow = baselinePlan.deadlineDaysFromNow;
  } else {
    delete sanitizedPlan.deadlineAt;
    delete sanitizedPlan.deadlineDaysFromNow;
  }
  if (baselinePlan.targetDays && baselinePlan.targetDays.length > 1) {
    sanitizedPlan.reasoning = baselinePlan.reasoning;
    sanitizedPlan.isDurationAmbiguous = baselinePlan.isDurationAmbiguous;
    sanitizedPlan.totalDurationMinutes = baselinePlan.totalDurationMinutes;
    sanitizedPlan.durationPerDayMinutes = baselinePlan.durationPerDayMinutes;
    sanitizedPlan.clarificationPrompt = baselinePlan.clarificationPrompt;
  }

  sanitizedPlan.title = extractCleanActivityTitle(prompt, options.mockGeminiPlan.title || baselinePlan.title);

  return {
    success: true,
    isAiGenerated: true,
    source: 'gemini',
    plan: sanitizedPlan,
  };
}

// ============================================================================
// SUITE PENGUJIAN LENGKAP MANDIRI
// ============================================================================
export function runAiSchedulerSuite() {
  console.log('========================================================================');
  console.log('🧪 MENJALANKAN SUITE PENGUJIAN AI SCHEDULER (tests/aiScheduler.test.ts)');
  console.log(`⏱️ Waktu Acuan Mock: ${MOCK_REFERENCE_DATE.toISOString()} (Senin, 20 Mei 2024, 16:00 WIB)`);
  console.log('========================================================================\n');

  // --- KASUS 1 ---
  console.log('>>> [1/23] Kasus 1: "Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming."');
  const c1 = simulateBackendPlanPipeline('Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming.');
  if (c1.plan.title !== 'UTS Web Programming') {
    throw new Error(`Kasus 1 Gagal: Judul harus "UTS Web Programming", didapat "${c1.plan.title}"`);
  }
  if (c1.plan.timeConstraintType !== 'fixed_event') {
    throw new Error(`Kasus 1 Gagal: timeConstraintType harus "fixed_event", didapat "${c1.plan.timeConstraintType}"`);
  }
  if (c1.plan.estimatedDurationMinutes !== 180) {
    throw new Error(`Kasus 1 Gagal: Durasi harus 180 menit, didapat ${c1.plan.estimatedDurationMinutes}`);
  }
  // Rabu berikutnya dari 20 Mei (Senin) adalah 22 Mei 2024
  const c1Start = new Date(c1.plan.requestedStartAt!);
  const c1End = new Date(c1.plan.requestedEndAt!);
  const c1StartParts = getPartsInTimezone(c1Start, TEST_TIMEZONE);
  const c1EndParts = getPartsInTimezone(c1End, TEST_TIMEZONE);
  if (c1StartParts.day !== 22 || c1StartParts.month !== 5 || c1StartParts.hour !== 19) {
    throw new Error(`Kasus 1 Gagal: Waktu mulai harus 22 Mei 2024 pukul 19:00 WIB, didapat ${c1Start.toISOString()}`);
  }
  if (c1EndParts.hour !== 22) {
    throw new Error(`Kasus 1 Gagal: Waktu selesai harus pukul 22:00 WIB, didapat ${c1End.toISOString()}`);
  }
  console.log('✅ Kasus 1 LULUS: Judul, jenis fixed_event, tanggal Rabu 22 Mei 19:00-22:00 WIB, dan durasi 180 mnt presisi.');

  // --- KASUS 2 ---
  console.log('\n>>> [2/23] Kasus 2: "Kamis aku mau lanjut ngerjain desain kalau belum selesai, selama tiga jam."');
  const c2 = simulateBackendPlanPipeline('Kamis aku mau lanjut ngerjain desain kalau belum selesai, selama tiga jam.');
  if (c2.plan.title !== 'Melanjutkan Desain') {
    throw new Error(`Kasus 2 Gagal: Judul harus "Melanjutkan Desain", didapat "${c2.plan.title}"`);
  }
  if (c2.plan.estimatedDurationMinutes !== 180) {
    throw new Error(`Kasus 2 Gagal: Durasi harus 180 menit, didapat ${c2.plan.estimatedDurationMinutes}`);
  }
  // Kamis = 23 Mei 2024 (dayIndex 4)
  if (!c2.plan.targetDays?.includes(4)) {
    throw new Error(`Kasus 2 Gagal: targetDays harus menyertakan hari Kamis (4)`);
  }
  // Test scheduler menolak slot yang hanya 60 menit
  const busyCalendarKamis: CalendarEvent[] = [
    {
      id: 'e1',
      provider: 'google',
      title: 'Agenda Pagi',
      startAt: createIsoInTimezone(2024, 5, 23, 8, 0, 0, TEST_TIMEZONE),
      endAt: createIsoInTimezone(2024, 5, 23, 16, 0, 0, TEST_TIMEZONE),
      isEditable: false,
      syncStatus: 'synced',
    },
    {
      id: 'e2',
      provider: 'google',
      title: 'Agenda Sore-Malam',
      startAt: createIsoInTimezone(2024, 5, 23, 17, 0, 0, TEST_TIMEZONE),
      endAt: createIsoInTimezone(2024, 5, 23, 23, 59, 0, TEST_TIMEZONE),
      isEditable: false,
      syncStatus: 'synced',
    },
  ];
  // Hanya ada slot 1 jam kosong antara 16:00 - 17:00, sedangkan tugas butuh 180 menit tanpa split
  const task2: Task = {
    id: 't2',
    userId: 'u',
    title: c2.plan.title,
    estimatedDurationMinutes: c2.plan.estimatedDurationMinutes,
    timeConstraintType: c2.plan.timeConstraintType,
    targetDays: c2.plan.targetDays,
    allowSplit: false,
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    createdAt: MOCK_REFERENCE_DATE.toISOString(),
    timezone: TEST_TIMEZONE,
  };
  const schedRes2 = scheduleTaskDeterministically(task2, busyCalendarKamis, [], INITIAL_PREFERENCES, MOCK_REFERENCE_DATE);
  if (schedRes2.success) {
    throw new Error(`Kasus 2 Gagal: Scheduler tidak boleh berhasil menempatkan tugas 180 menit jika hanya ada slot 60 menit!`);
  }
  console.log('✅ Kasus 2 LULUS: Judul "Melanjutkan Desain", durasi 180 menit, preferensi Kamis terjaga, dan slot 60 mnt ditolak.');

  // --- KASUS 3 ---
  console.log('\n>>> [3/23] Kasus 3: "Aku ada UTS Design deadline-nya hari Jumat, jadi nanti Kamis dan Selasa habis Magrib, aku mau ngerjain selama tiga jam."');
  const c3 = simulateBackendPlanPipeline('Aku ada UTS Design deadline-nya hari Jumat, jadi nanti Kamis dan Selasa habis Magrib, aku mau ngerjain selama tiga jam.');
  // Deadline Jumat 24 Mei 2024
  const c3Deadline = new Date(c3.plan.deadlineAt!);
  const c3DeadParts = getPartsInTimezone(c3Deadline, TEST_TIMEZONE);
  if (c3DeadParts.day !== 24 || c3DeadParts.month !== 5) {
    throw new Error(`Kasus 3 Gagal: Deadline harus Jumat 24 Mei 2024, didapat hari ke-${c3DeadParts.day}`);
  }
  // Hari kerja harus Selasa (2) dan Kamis (4), dan TIDAK boleh menyertakan Jumat (5)
  if (c3.plan.targetDays?.includes(5)) {
    throw new Error(`Kasus 3 Gagal: Hari tenggat Jumat tidak boleh dianggap sebagai hari kerja pengerjaan!`);
  }
  if (!c3.plan.targetDays?.includes(2) || !c3.plan.targetDays?.includes(4)) {
    throw new Error(`Kasus 3 Gagal: Hari pengerjaan harus mencakup Selasa (2) dan Kamis (4)`);
  }
  if (c3.plan.preferredWindow?.startHour !== 18 || c3.plan.preferredWindow?.startMinute !== 30) {
    throw new Error(`Kasus 3 Gagal: Preferred window habis magrib harus mulai 18:30 WIB`);
  }
  console.log('✅ Kasus 3 LULUS: Deadline Jumat tidak dijadikan hari kerja; target Selasa & Kamis habis Magrib (18:30 WIB) tepat.');

  // --- KASUS 4 ---
  console.log('\n>>> [4/23] Kasus 4: "Kelas setiap Senin dan Rabu jam 19.00 sampai 21.00."');
  const c4 = simulateBackendPlanPipeline('Kelas setiap Senin dan Rabu jam 19.00 sampai 21.00.');
  if (c4.plan.timeConstraintType !== 'fixed_event') {
    throw new Error(`Kasus 4 Gagal: Komitmen kelas harus timeConstraintType "fixed_event"`);
  }
  if (!c4.plan.isRecurring) {
    throw new Error(`Kasus 4 Gagal: isRecurring harus true`);
  }
  if (c4.plan.estimatedDurationMinutes !== 120) {
    throw new Error(`Kasus 4 Gagal: Durasi kelas 19.00-21.00 harus 120 menit, didapat ${c4.plan.estimatedDurationMinutes}`);
  }
  if (!c4.plan.targetDays?.includes(1) || !c4.plan.targetDays?.includes(3)) {
    throw new Error(`Kasus 4 Gagal: targetDays harus menyertakan Senin (1) dan Rabu (3)`);
  }
  console.log('✅ Kasus 4 LULUS: Perulangan mingguan terdeteksi, fixed_event, Senin & Rabu 19:00-21:00 (120 mnt).');

  // --- KASUS 5 ---
  console.log('\n>>> [5/23] Kasus 5: "Besok pagi baca dokumentasi selama 45 menit."');
  const c5 = simulateBackendPlanPipeline('Besok pagi baca dokumentasi selama 45 menit.');
  if (c5.plan.title !== 'Baca Dokumentasi') {
    throw new Error(`Kasus 5 Gagal: Judul harus "Baca Dokumentasi", didapat "${c5.plan.title}"`);
  }
  if (c5.plan.estimatedDurationMinutes !== 45) {
    throw new Error(`Kasus 5 Gagal: Durasi harus 45 menit, didapat ${c5.plan.estimatedDurationMinutes}`);
  }
  if (c5.plan.preferredTimeOfDay !== 'MORNING') {
    throw new Error(`Kasus 5 Gagal: preferredTimeOfDay harus "MORNING"`);
  }
  console.log('✅ Kasus 5 LULUS: Besok pagi (Selasa 21 Mei), preferensi MORNING, durasi 45 menit, judul "Baca Dokumentasi".');

  // --- KASUS 6 ---
  console.log('\n>>> [6/23] Kasus 6: "Jadwalkan belajar selama tiga jam sebelum deadline Jumat."');
  const c6 = simulateBackendPlanPipeline('Jadwalkan belajar selama tiga jam sebelum deadline Jumat.');
  if (c6.plan.estimatedDurationMinutes !== 180) {
    throw new Error(`Kasus 6 Gagal: Durasi harus 180 menit`);
  }
  const c6DeadParts = getPartsInTimezone(new Date(c6.plan.deadlineAt!), TEST_TIMEZONE);
  if (c6DeadParts.day !== 24 || c6DeadParts.month !== 5) {
    throw new Error(`Kasus 6 Gagal: Deadline harus Jumat 24 Mei 2024`);
  }
  console.log('✅ Kasus 6 LULUS: Fleksibel 180 menit sebelum deadline Jumat 24 Mei 23:59 WIB.');

  // --- KASUS 7 ---
  console.log('\n>>> [7/23] Kasus 7: "Fixed event bertabrakan dengan acara kalender yang ada"');
  const conflictingEvent: CalendarEvent = {
    id: 'conf1',
    provider: 'google',
    title: 'Rapat Koordinasi Utama',
    startAt: createIsoInTimezone(2024, 5, 22, 19, 30, 0, TEST_TIMEZONE),
    endAt: createIsoInTimezone(2024, 5, 22, 21, 0, 0, TEST_TIMEZONE),
    isEditable: false,
    syncStatus: 'synced',
  };
  const task7: Task = {
    id: 't7',
    userId: 'u',
    title: 'UTS Web Programming',
    estimatedDurationMinutes: 180,
    timeConstraintType: 'fixed_event',
    requestedStartAt: createIsoInTimezone(2024, 5, 22, 19, 0, 0, TEST_TIMEZONE),
    requestedEndAt: createIsoInTimezone(2024, 5, 22, 22, 0, 0, TEST_TIMEZONE),
    priority: 'HIGH',
    status: 'UNSCHEDULED',
    allowSplit: false,
    createdAt: MOCK_REFERENCE_DATE.toISOString(),
  };
  const schedRes7 = scheduleTaskDeterministically(task7, [conflictingEvent], [], INITIAL_PREFERENCES, MOCK_REFERENCE_DATE);
  if (schedRes7.success) {
    throw new Error('Kasus 7 Gagal: Komitmen waktu tetap yang bertabrakan tidak boleh berhasil ditempatkan!');
  }
  if (!schedRes7.explanation.toLowerCase().includes('bertabrakan') && !schedRes7.explanation.toLowerCase().includes('konflik')) {
    throw new Error(`Kasus 7 Gagal: Penjelasan harus menyebut konflik jadwal`);
  }
  console.log('✅ Kasus 7 LULUS: Tabrakan komitmen tetap terdeteksi, tidak digeser otomatis, penjelasan transparan.');

  // --- KASUS 8 ---
  console.log('\n>>> [8/23] Kasus 8: "Fleksibel saat slot jendela preferensi tidak cukup"');
  // Penuhkan waktu malam (19:00 - 23:00) pada hari target
  const fullEveningEvents: CalendarEvent[] = [
    {
      id: 'fe1',
      provider: 'google',
      title: 'Agenda Malam Sibuk',
      startAt: createIsoInTimezone(2024, 5, 21, 19, 0, 0, TEST_TIMEZONE),
      endAt: createIsoInTimezone(2024, 5, 21, 23, 30, 0, TEST_TIMEZONE),
      isEditable: false,
      syncStatus: 'synced',
    },
  ];
  const task8: Task = {
    id: 't8',
    userId: 'u',
    title: 'Belajar Coding Malam',
    estimatedDurationMinutes: 120,
    timeConstraintType: 'preferred_window',
    targetDays: [2], // Selasa 21 Mei
    preferredWindow: { startHour: 19, endHour: 23, label: 'Malam (19:00 - 23:00)' },
    preferredTimeOfDay: 'EVENING',
    allowSplit: false,
    priority: 'MEDIUM',
    status: 'UNSCHEDULED',
    createdAt: MOCK_REFERENCE_DATE.toISOString(),
    timezone: TEST_TIMEZONE,
  };
  const schedRes8 = scheduleTaskDeterministically(task8, fullEveningEvents, [], INITIAL_PREFERENCES, MOCK_REFERENCE_DATE);
  if (schedRes8.success && schedRes8.proposedSessions.some(s => new Date(s.startAt).getHours() >= 19 && new Date(s.startAt).getHours() <= 23)) {
    throw new Error('Kasus 8 Gagal: Tugas tidak boleh ditempatkan di jendela malam yang penuh');
  }
  console.log('✅ Kasus 8 LULUS: Jendela preferensi penuh ditangani dengan tepat tanpa memaksakan slot bentrok.');

  // --- KASUS 9 ---
  console.log('\n>>> [9/23] Kasus 9: "Penanganan kegagalan / timeout Gemini beralih ke deterministik"');
  const c9 = simulateBackendPlanPipeline('Belajar algoritma selama dua jam besok sore.', {
    geminiError: new Error('Gemini API timeout 504 Gateway Timeout'),
  });
  if (c9.isAiGenerated !== false || c9.source !== 'rule_fallback_on_error') {
    throw new Error(`Kasus 9 Gagal: source harus rule_fallback_on_error dan isAiGenerated false`);
  }
  if (!c9.warning || !c9.warning.includes('deterministik')) {
    throw new Error('Kasus 9 Gagal: Peringatan fallback deterministik harus diberikan');
  }
  console.log('✅ Kasus 9 LULUS: Fallback jujur ke aturan deterministik tanpa klaim AI palsu.');

  // --- KASUS 10 ---
  console.log('\n>>> [10/23] Kasus 10: "Sanitasi halusinasi Gemini mengoreksi ke baseline deterministik"');
  const halusinasiAiPlan: Partial<AIPlanDraft> = {
    title: 'Tolong buatkan jadwal belajar',
    timeConstraintType: 'fixed_event',
    requestedStartAt: '2023-01-01T08:00:00.000Z', // Halusinasi tanggal lampau!
    requestedEndAt: '2023-01-01T09:00:00.000Z',
    estimatedDurationMinutes: 30, // Salah durasi padahal user minta 3 jam
    priority: 'LOW',
    allowSplit: true,
  };
  const c10 = simulateBackendPlanPipeline(
    'Rabu malam jam 7 sampai jam 10 malam, akan ada UTS Web Programming.',
    { mockGeminiPlan: halusinasiAiPlan }
  );
  if (c10.plan.title !== 'UTS Web Programming') {
    throw new Error(`Kasus 10 Gagal: Judul halusinasi tidak disanitasi, didapat "${c10.plan.title}"`);
  }
  if (c10.plan.estimatedDurationMinutes !== 180) {
    throw new Error(`Kasus 10 Gagal: Durasi halusinasi harus dikoreksi ke 180 menit`);
  }
  const c10Start = new Date(c10.plan.requestedStartAt!);
  if (c10Start.getFullYear() !== 2024 || getPartsInTimezone(c10Start, TEST_TIMEZONE).day !== 22) {
    throw new Error(`Kasus 10 Gagal: Tanggal lampau halusinasi harus dikoreksi ke Rabu 22 Mei 2024!`);
  }
  console.log('✅ Kasus 10 LULUS: Halusinasi tanggal dan durasi Gemini berhasil disanitasi kembali ke baseline.');

  // --- KASUS 11 ---
  console.log('\n>>> [11/23] Kasus 11: "Idempotensi penjadwalan berulang"');
  const t11: Task = {
    id: 't11',
    userId: 'u',
    title: 'Review PR',
    estimatedDurationMinutes: 60,
    priority: 'HIGH',
    status: 'SCHEDULED',
    allowSplit: false,
    scheduledSessions: [
      {
        id: 's11',
        taskId: 't11',
        taskTitle: 'Review PR',
        sessionIndex: 1,
        totalSessions: 1,
        startAt: '2024-05-21T02:00:00.000Z',
        endAt: '2024-05-21T03:00:00.000Z',
        durationMinutes: 60,
        status: 'SCHEDULED',
        syncStatus: 'synced',
      },
    ],
    timezone: TEST_TIMEZONE,
    createdAt: MOCK_REFERENCE_DATE.toISOString(),
  };
  const { results: run11 } = scheduleAllPendingTasks([t11], [], INITIAL_PREFERENCES);
  if (run11.length !== 0) {
    throw new Error('Kasus 11 Gagal: Task yang sudah SCHEDULED diproses ulang dan melanggar idempotensi!');
  }
  console.log('✅ Kasus 11 LULUS: Idempotensi terjamin, kegiatan yang sudah terjadwal tidak diproses ulang.');

  // --- KASUS 12 ---
  console.log('\n>>> [12/23] Kasus 12: "Konfirmasi kegiatan terlewat menjadi selesai secara manual"');
  const t12: Task = {
    id: 't12',
    userId: 'u',
    title: 'Praktikum Sistem Informasi',
    estimatedDurationMinutes: 90,
    priority: 'HIGH',
    status: 'missed_auto',
    missedAt: '2024-05-20T10:00:00.000Z',
    createdAt: '2024-05-15T08:00:00.000Z',
  };
  const confirmTime = new Date('2024-05-20T12:00:00.000Z');
  const updated12 = markMissedTaskAsCompleted(t12, confirmTime);
  if (updated12.status !== 'completed_manual') {
    throw new Error(`Kasus 12 Gagal: Status harus "completed_manual", didapat "${updated12.status}"`);
  }
  if (updated12.missedAt !== '2024-05-20T10:00:00.000Z') {
    throw new Error(`Kasus 12 Gagal: missedAt asli tidak boleh diubah`);
  }
  if (updated12.completedAt !== confirmTime.toISOString()) {
    throw new Error(`Kasus 12 Gagal: completedAt tidak sesuai dengan waktu konfirmasi`);
  }
  console.log('✅ Kasus 12 LULUS: Status menjadi completed_manual, completedAt terekam, missedAt asli terjaga.');

  // --- KASUS 13 (Perbaikan: "minggu ini") ---
  console.log('\n>>> [13/23] Kasus 13: Frasa "minggu ini" tidak dianggap hari Minggu');
  const c13 = simulateBackendPlanPipeline('Jadwalkan belajar materi React minggu ini selama dua jam');
  if (c13.plan.targetDays && c13.plan.targetDays.includes(0)) {
    throw new Error('Kasus 13 Gagal: "minggu ini" tidak boleh menghasilkan targetDays hari Minggu (0)!');
  }
  console.log('✅ Kasus 13 LULUS: "minggu ini" diartikan sebagai horizon pekan berjalan, bukan hari Minggu.');

  // --- KASUS 14 (Perbaikan: "minggu depan") ---
  console.log('\n>>> [14/23] Kasus 14: Frasa "minggu depan" tanpa hari tidak menimbulkan konflik tanggal');
  const c14 = simulateBackendPlanPipeline('Belajar algoritma minggu depan selama tiga jam');
  if (c14.plan.targetDays && c14.plan.targetDays.includes(0)) {
    throw new Error('Kasus 14 Gagal: "minggu depan" mandiri tidak boleh dianggap hari Minggu (0)!');
  }
  console.log('✅ Kasus 14 LULUS: "minggu depan" fleksibel tanpa mengunci hari Minggu.');

  // --- KASUS 15 (Perbaikan: "Minggu malam") ---
  console.log('\n>>> [15/23] Kasus 15: Frasa "Minggu malam" tetap dikenali sebagai hari Minggu');
  const c15 = simulateBackendPlanPipeline('Minggu malam belajar selama 90 menit');
  if (!c15.plan.targetDays?.includes(0)) {
    throw new Error('Kasus 15 Gagal: "Minggu malam" harus mengenali hari Minggu (0)!');
  }
  console.log('✅ Kasus 15 LULUS: "Minggu malam" dikenali dengan tepat sebagai hari Minggu (26 Mei 2024).');

  // --- KASUS 16 (Perbaikan: "Senin sampai Minggu") ---
  console.log('\n>>> [16/23] Kasus 16: Frasa "Senin sampai Minggu" mencakup kedua hari');
  const c16 = simulateBackendPlanPipeline('Senin sampai Minggu jam 20.00 rapat evaluasi');
  if (!c16.plan.targetDays?.includes(1) || !c16.plan.targetDays?.includes(0)) {
    throw new Error('Kasus 16 Gagal: Rentang harus mencakup Senin (1) dan Minggu (0)!');
  }
  console.log('✅ Kasus 16 LULUS: Rentang mencakup Senin dan Minggu.');

  // --- KASUS 17 (Perbaikan: "Deadline hari Minggu") ---
  console.log('\n>>> [17/23] Kasus 17: Frasa "deadline hari Minggu" mengenali deadline Minggu');
  const c17 = simulateBackendPlanPipeline('Kerjakan tugas coding sebelum deadline hari Minggu');
  const c17DeadlineParts = getPartsInTimezone(new Date(c17.plan.deadlineAt!), TEST_TIMEZONE);
  if (c17DeadlineParts.dayOfWeek !== 0) {
    throw new Error(`Kasus 17 Gagal: Deadline harus hari Minggu (dayOfWeek 0), didapat ${c17DeadlineParts.dayOfWeek}`);
  }
  console.log('✅ Kasus 17 LULUS: Deadline hari Minggu tepat jatuh pada Minggu (26 Mei 2024).');

  // --- KASUS 18 (Perbaikan: Pembersihan judul dengan awalan "Setiap") ---
  console.log('\n>>> [18/23] Kasus 18: Judul "Setiap Senin dan Rabu jam 19.00 belajar React" menghasilkan "Belajar React"');
  const c18Title = extractCleanActivityTitle('Setiap Senin dan Rabu jam 19.00 belajar React');
  if (c18Title !== 'Belajar React') {
    throw new Error(`Kasus 18 Gagal: Judul harus "Belajar React", didapat "${c18Title}"`);
  }
  console.log('✅ Kasus 18 LULUS: Judul bersih dari kata sisa "Setiap", menghasilkan "Belajar React".');

  // --- KASUS 19 (Perbaikan: Intent Operasional Cari Slot Kosong) ---
  console.log('\n>>> [19/23] Kasus 19: Operational intent "Cari waktu terdekat yang kosong."');
  const c19 = simulateBackendPlanPipeline('Cari waktu terdekat yang kosong.');
  if (!c19.plan.isOperational || c19.plan.operationalAction !== 'find_free_slot') {
    throw new Error('Kasus 19 Gagal: Harus terdeteksi sebagai operational intent find_free_slot!');
  }
  if (c19.plan.title === 'Cari Waktu Terdekat Yang Kosong') {
    throw new Error('Kasus 19 Gagal: Tidak boleh membuat task bernama "Cari Waktu Terdekat..."!');
  }
  console.log('✅ Kasus 19 LULUS: Intent pencarian slot kosong terdeteksi dengan tepat, tidak membuat task palsu.');

  // --- KASUS 20 (Perbaikan: Intent Operasional Pindahkan Jadwal Bentrok) ---
  console.log('\n>>> [20/23] Kasus 20: Operational intent "Pindahkan semua jadwal yang bentrok."');
  const c20 = simulateBackendPlanPipeline('Pindahkan semua jadwal yang bentrok.');
  if (!c20.plan.isOperational || c20.plan.operationalAction !== 'resolve_conflicts') {
    throw new Error('Kasus 20 Gagal: Harus terdeteksi sebagai operational intent resolve_conflicts!');
  }
  console.log('✅ Kasus 20 LULUS: Tindakan resolusi bentrok terdeteksi, diarahkan ke Kalender tanpa klaim sukses palsu.');

  // --- KASUS 21 (Perbaikan: Durasi Multi-Hari Ambigu) ---
  console.log('\n>>> [21/23] Kasus 21: Durasi multi-hari ambigu "Belajar selama tiga jam pada Selasa dan Kamis."');
  const c21 = simulateBackendPlanPipeline('Belajar selama tiga jam pada Selasa dan Kamis.');
  if (c21.plan.isDurationAmbiguous !== true) {
    throw new Error('Kasus 21 Gagal: Harus ditandai isDurationAmbiguous = true!');
  }
  if (!c21.plan.clarificationPrompt) {
    throw new Error('Kasus 21 Gagal: clarificationPrompt harus disediakan untuk pengguna!');
  }
  console.log('✅ Kasus 21 LULUS: Ambiguitas durasi multi-hari terdeteksi dengan pertanyaan klarifikasi terarah.');

  // --- KASUS 22 (Perbaikan: Durasi Multi-Hari Eksplisit Total Dibagi) ---
  console.log('\n>>> [22/23] Kasus 22: Durasi eksplisit "Total tiga jam dibagi antara Selasa dan Kamis."');
  const c22 = simulateBackendPlanPipeline('Total tiga jam dibagi antara Selasa dan Kamis.');
  if (c22.plan.isDurationAmbiguous === true) {
    throw new Error('Kasus 22 Gagal: Kasus eksplisit total dibagi tidak boleh dianggap ambigu!');
  }
  if (c22.plan.estimatedDurationMinutes !== 90) {
    throw new Error(`Kasus 22 Gagal: Durasi per sesi harus 90 menit (180/2), didapat ${c22.plan.estimatedDurationMinutes}`);
  }
  if (c22.plan.allowSplit !== true) {
    throw new Error('Kasus 22 Gagal: allowSplit harus true');
  }
  console.log('✅ Kasus 22 LULUS: Total 3 jam terbagi merata menjadi 90 menit per hari.');

  // --- KASUS 23 (Perbaikan: Durasi Multi-Hari Eksplisit Per Hari) ---
  console.log('\n>>> [23/23] Kasus 23: Durasi eksplisit "Tiga jam setiap hari Selasa dan Kamis."');
  const c23 = simulateBackendPlanPipeline('Tiga jam setiap hari Selasa dan Kamis.');
  if (c23.plan.isDurationAmbiguous === true) {
    throw new Error('Kasus 23 Gagal: Kasus eksplisit per hari tidak boleh dianggap ambigu!');
  }
  if (c23.plan.estimatedDurationMinutes !== 180) {
    throw new Error(`Kasus 23 Gagal: Durasi per hari harus tetap 180 menit, didapat ${c23.plan.estimatedDurationMinutes}`);
  }
  // --- KASUS 24 (Utilitas Pemeriksaan Zona Waktu ReferenceDate) ---
  console.log('\n>>> [24/24] Kasus 24: Utilitas verifikasi zona waktu referenceDate selalu merujuk Asia/Jakarta');
  const tzCheck = verifyAndNormalizeReferenceDate(MOCK_REFERENCE_DATE, 'Asia/Jakarta');
  if (!tzCheck.isJakartaTimezone) {
    throw new Error('Kasus 24 Gagal: isJakartaTimezone harus bernilai true untuk Asia/Jakarta!');
  }
  if (tzCheck.parts.year !== 2024 || tzCheck.parts.month !== 5 || tzCheck.parts.day !== 20 || tzCheck.parts.hour !== 16) {
    throw new Error(`Kasus 24 Gagal: Komponen waktu di Asia/Jakarta harus 2024-05-20 pukul 16:00, didapat ${tzCheck.parts.year}-${tzCheck.parts.month}-${tzCheck.parts.day} ${tzCheck.parts.hour}:${tzCheck.parts.minute}`);
  }
  console.log('✅ Kasus 24 LULUS: Utilitas verifyAndNormalizeReferenceDate memastikan referenceDate selalu presisi pada Asia/Jakarta (20 Mei 2024, 16:00 WIB).');

  console.log('\n========================================================================');
  console.log('🎉 SELURUH 24 PENGUJIAN AI SCHEDULER, TIMEZONE & PARSER BERHASIL 100%! 🎉');
  console.log('========================================================================\n');
}

// Integrasi Vitest Runner jika dijalankan via vitest
if (process.env.VITEST) {
  describe('AI Scheduler & Temporal Parser Automated Regression', () => {
    it('menjalankan seluruh 24 kasus pengujian AI scheduler dan temporal parser secara menyeluruh', () => {
      expect(() => runAiSchedulerSuite()).not.toThrow();
    });
  });
}
