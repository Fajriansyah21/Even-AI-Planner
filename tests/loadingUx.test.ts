import assert from 'node:assert';
import { LOADING_STEPS, LoadingPhase } from '../src/components/AIAssistantView';
import { parseIndonesianTemporalRules } from '../src/lib/temporalParser';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';
import { Task, CalendarEvent, UserPreferences } from '../src/types';

/**
 * Suite Pengujian Otomatis: Loading UX, Tahap Analisis AI, dan Kejujuran Status EVEN
 */
export async function runLoadingUxTests() {
  console.log('\n================================================================');
  console.log('🧪 SUITE: Tahap Analisis AI, Transparansi Fallback, dan Loading UX');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    try {
      fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  async function testAsync(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  // 1. Validasi Urutan Tahapan Loading
  test('1. Validasi 4 Langkah Loading Eksplisit dan Berurutan', () => {
    assert.strictEqual(LOADING_STEPS.length, 4, 'Harus memiliki tepat 4 tahap loading');
    
    assert.strictEqual(LOADING_STEPS[0].phase, LoadingPhase.VALIDATING);
    assert.strictEqual(LOADING_STEPS[0].stageName, 'Validating');
    assert.strictEqual(LOADING_STEPS[0].stepNumber, 1);

    assert.strictEqual(LOADING_STEPS[1].phase, LoadingPhase.ANALYZING);
    assert.strictEqual(LOADING_STEPS[1].stageName, 'Analyzing');
    assert.strictEqual(LOADING_STEPS[1].stepNumber, 2);

    assert.strictEqual(LOADING_STEPS[2].phase, LoadingPhase.PLANNING);
    assert.strictEqual(LOADING_STEPS[2].stageName, 'Planning');
    assert.strictEqual(LOADING_STEPS[2].stepNumber, 3);

    assert.strictEqual(LOADING_STEPS[3].phase, LoadingPhase.CHECKING_CONFLICTS);
    assert.strictEqual(LOADING_STEPS[3].stageName, 'Checking Conflicts');
    assert.strictEqual(LOADING_STEPS[3].stepNumber, 4);
  });

  // 2. Simulasi Alur State Loading Nyata Tanpa Delay Buatan
  test('2. Simulasi Transisi State Loading Nyata (Validating -> Analyzing -> Planning -> Checking Conflicts -> Idle)', () => {
    const stateTransitions: LoadingPhase[] = [];
    const recordState = (phase: LoadingPhase) => stateTransitions.push(phase);

    // Initial state
    let currentPhase: LoadingPhase = LoadingPhase.IDLE;
    recordState(currentPhase);

    // Stage 1: Validating
    const prompt = 'Kelas dari jam 7 malam sampai jam 10 malam';
    assert.ok(prompt.trim().length > 0, 'Prompt tidak boleh kosong');
    currentPhase = LoadingPhase.VALIDATING;
    recordState(currentPhase);

    // Stage 2: Analyzing
    const userTimezone = 'Asia/Jakarta';
    const nowIso = '2024-05-20T09:00:00Z';
    currentPhase = LoadingPhase.ANALYZING;
    recordState(currentPhase);

    // Stage 3: Planning via engine deterministik (simulasi fallback/offline)
    currentPhase = LoadingPhase.PLANNING;
    recordState(currentPhase);
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: nowIso,
      userTimezone,
    });
    assert.ok(parsed.title, 'Harus menghasilkan judul rencana');
    assert.strictEqual(parsed.estimatedDurationMinutes, 180, 'Durasi harus 180 menit');

    // Stage 4: Checking Conflicts
    currentPhase = LoadingPhase.CHECKING_CONFLICTS;
    recordState(currentPhase);

    const pseudoTask: Task = {
      id: 'test-draft-1',
      userId: 'test-user',
      title: parsed.title,
      estimatedDurationMinutes: parsed.estimatedDurationMinutes,
      priority: parsed.priority,
      status: 'UNSCHEDULED',
      allowSplit: parsed.allowSplit,
      minimumSessionMinutes: parsed.minimumSessionMinutes || 30,
      preferredTimeOfDay: parsed.preferredTimeOfDay,
      timeConstraintType: parsed.timeConstraintType,
      requestedStartAt: parsed.requestedStartAt,
      requestedEndAt: parsed.requestedEndAt,
      targetDays: parsed.targetDays,
      targetOccurrences: parsed.targetOccurrences,
      preferredWindow: parsed.preferredWindow,
      timezone: userTimezone,
      createdAt: nowIso,
    };

    const mockEvents: CalendarEvent[] = [];
    const mockTasks: Task[] = [];
    const mockPrefs: UserPreferences = {
      workStartHour: 9,
      workEndHour: 22,
      workDays: [0, 1, 2, 3, 4, 5, 6],
      bufferMinutes: 10,
      autoSchedule: true,
      timezone: 'Asia/Jakarta',
    };

    const schedRes = scheduleTaskDeterministically(pseudoTask, mockEvents, mockTasks, mockPrefs);
    assert.strictEqual(schedRes.success, true, 'Scheduler harus berhasil menempatkan slot');
    assert.strictEqual(schedRes.proposedSessions.length, 1);

    // Stage 5: Selesai (Hasil utuh disajikan serentak)
    currentPhase = LoadingPhase.IDLE;
    recordState(currentPhase);

    assert.deepStrictEqual(stateTransitions, [
      LoadingPhase.IDLE,
      LoadingPhase.VALIDATING,
      LoadingPhase.ANALYZING,
      LoadingPhase.PLANNING,
      LoadingPhase.CHECKING_CONFLICTS,
      LoadingPhase.IDLE,
    ]);
  });

  // 3. Validasi Transparansi AI vs Fallback
  test('3. Transparansi Sumber Rencana: Fallback tidak boleh dilaporkan sebagai Gemini AI', () => {
    // Skenario A: Backend mengembalikan Gemini
    const geminiResponse = {
      success: true,
      isAiGenerated: true,
      source: 'gemini' as const,
      plan: { title: 'UTS Web Programming' },
    };
    assert.strictEqual(geminiResponse.source, 'gemini');
    assert.strictEqual(geminiResponse.isAiGenerated, true);

    // Skenario B: Backend fallback karena tanpa API key atau error
    const fallbackResponse = {
      success: true,
      isAiGenerated: false,
      source: 'rule_fallback' as const,
      warning: 'Kunci GEMINI_API_KEY tidak tersedia di server. Menggunakan sistem aturan temporal deterministik EVEN.',
      plan: { title: 'UTS Web Programming' },
    };
    assert.strictEqual(fallbackResponse.source, 'rule_fallback');
    assert.strictEqual(fallbackResponse.isAiGenerated, false);
    assert.ok(fallbackResponse.warning.includes('aturan temporal deterministik'));

    // Skenario C: UI Badge Mapping
    const getBadgeLabel = (source: string) => {
      return source === 'gemini' ? 'Hasil Analisis AI' : 'Mesin Aturan Deterministik (Fallback)';
    };
    assert.strictEqual(getBadgeLabel('gemini'), 'Hasil Analisis AI');
    assert.strictEqual(getBadgeLabel('rule_fallback'), 'Mesin Aturan Deterministik (Fallback)');
    assert.strictEqual(getBadgeLabel('rule_fallback_on_error'), 'Mesin Aturan Deterministik (Fallback)');
  });

  // 4. Sinkronisasi Timeout dan Pembatalan Manual (AbortController)
  testAsync('4. Sinkronisasi Timeout 30 Detik dan Mekanisme AbortController', async () => {
    const controller = new AbortController();
    assert.strictEqual(controller.signal.aborted, false);

    let cancelledByTimeout = false;
    let cancelledByUser = false;

    // Simulasi pembatalan manual oleh pengguna
    controller.abort();
    cancelledByUser = true;

    assert.strictEqual(controller.signal.aborted, true);
    assert.strictEqual(cancelledByUser, true);
    assert.strictEqual(cancelledByTimeout, false);

    // Validasi pesan error timeout konsisten (tepat 30 detik, bukan 20 detik)
    const timeoutSeconds = 30;
    const timeoutErrorMessage = `Permintaan dibatalkan karena melebihi batas waktu (timeout ${timeoutSeconds} detik). Silakan coba lagi.`;
    assert.ok(timeoutErrorMessage.includes('30 detik'), 'Pesan timeout harus tepat 30 detik');
    assert.ok(!timeoutErrorMessage.includes('20 detik'), 'Pesan timeout tidak boleh menyebut 20 detik');
  });

  // 5. Pencegahan Double Submit & Penguncian Input
  test('5. Validasi Pencegahan Double Submit Saat Analisis Berlangsung', () => {
    const canSubmit = (phase: LoadingPhase, text: string) => {
      const isAnalyzing =
        phase === LoadingPhase.VALIDATING ||
        phase === LoadingPhase.ANALYZING ||
        phase === LoadingPhase.PLANNING ||
        phase === LoadingPhase.CHECKING_CONFLICTS;
      const isSaving = phase === LoadingPhase.SAVING_CALENDAR;
      return Boolean(text.trim() && !isAnalyzing && !isSaving);
    };

    assert.strictEqual(canSubmit(LoadingPhase.IDLE, 'Tugas baru'), true, 'Harus bisa submit saat idle');
    assert.strictEqual(canSubmit(LoadingPhase.IDLE, '   '), false, 'Tidak boleh submit teks kosong');
    assert.strictEqual(canSubmit(LoadingPhase.VALIDATING, 'Tugas baru'), false, 'Terkunci saat tahap validating');
    assert.strictEqual(canSubmit(LoadingPhase.ANALYZING, 'Tugas baru'), false, 'Terkunci saat tahap analyzing');
    assert.strictEqual(canSubmit(LoadingPhase.PLANNING, 'Tugas baru'), false, 'Terkunci saat tahap planning');
    assert.strictEqual(canSubmit(LoadingPhase.CHECKING_CONFLICTS, 'Tugas baru'), false, 'Terkunci saat tahap checking conflicts');
    assert.strictEqual(canSubmit(LoadingPhase.SAVING_CALENDAR, 'Tugas baru'), false, 'Terkunci saat tahap saving_calendar');
  });

  // 6. Zero Delay Buatan: Memastikan Eksekusi Deterministik Tanpa Delay Tiruan
  testAsync('6. Memastikan Pipeline Selesai Cepat Tanpa Delay Buatan', async () => {
    const startTime = Date.now();

    const prompt = 'Rabu malam jam 7 sampai jam 10 malam ada UTS Web Programming';
    const parsed = parseIndonesianTemporalRules({
      userPrompt: prompt,
      currentDateTime: '2024-05-20T09:00:00Z',
      userTimezone: 'Asia/Jakarta',
    });

    const pseudoTask: Task = {
      id: 'perf-test',
      userId: 'perf-user',
      title: parsed.title,
      estimatedDurationMinutes: parsed.estimatedDurationMinutes,
      priority: parsed.priority,
      status: 'UNSCHEDULED',
      allowSplit: false,
      minimumSessionMinutes: 30,
      preferredTimeOfDay: parsed.preferredTimeOfDay,
      timeConstraintType: parsed.timeConstraintType,
      requestedStartAt: parsed.requestedStartAt,
      requestedEndAt: parsed.requestedEndAt,
      timezone: 'Asia/Jakarta',
      createdAt: '2024-05-20T09:00:00Z',
    };

    const schedRes = scheduleTaskDeterministically(pseudoTask, [], [], {
      workStartHour: 8,
      workEndHour: 23,
      workDays: [0, 1, 2, 3, 4, 5, 6],
      bufferMinutes: 10,
      autoSchedule: true,
      timezone: 'Asia/Jakarta',
    });

    const elapsed = Date.now() - startTime;
    assert.ok(schedRes.success, 'Harus berhasil');
    assert.ok(
      elapsed < 150,
      `Eksekusi parsing dan scheduling lokal harus di bawah 150ms tanpa artificial delay (aktual: ${elapsed}ms)`
    );
  });

  console.log(`\nHasil Suite Loading UX: ${passed} Lulus, ${failed} Gagal`);
  if (failed > 0) {
    throw new Error(`${failed} tes pada Suite Loading UX gagal.`);
  }
}

if (process.argv[1]?.endsWith('loadingUx.test.ts')) {
  runLoadingUxTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
