import { GoogleGenAI, Type } from '@google/genai';
import { NextRequest, NextResponse } from 'next/server';
import { parseIndonesianTemporalRules, ParseContext } from '../../../../src/lib/temporalParser';
import {
  classifyGeminiError,
  executeWithRetryAndTimeout,
} from '../../../../src/lib/geminiErrorHandling';

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const { userPrompt, currentDateTime, userLocalTimeStr, userTimezone, workHours } = await req.json();

    if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
      return NextResponse.json(
        {
          success: false,
          errorCode: 'AI_INVALID_REQUEST',
          error: 'Permintaan teks tidak boleh kosong.',
        },
        { status: 400 }
      );
    }

    // Limit prompt length to prevent unbounded inputs
    const trimmedPrompt = userPrompt.trim().slice(0, 600);

    const ctx: ParseContext = {
      userPrompt: trimmedPrompt,
      currentDateTime: currentDateTime || new Date().toISOString(),
      userLocalTimeStr,
      userTimezone: userTimezone || 'Asia/Jakarta',
      workHours,
    };

    // Calculate baseline deterministic rule-based plan
    const baselinePlan = parseIndonesianTemporalRules(ctx);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const elapsedMs = Date.now() - startTime;
      console.log(`[AI Plan Diagnostics] Duration: ${elapsedMs}ms | Mode: rule_fallback | No API key configured`);
      // Deterministic rule-based engine when API key is absent - clearly labeled!
      return NextResponse.json({
        success: true,
        isAiGenerated: false,
        source: 'rule_fallback',
        warning: 'Kunci GEMINI_API_KEY tidak tersedia di server. Menggunakan sistem aturan temporal deterministik EVEN.',
        plan: baselinePlan,
      });
    }

    const ai = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
        retryOptions: {
          attempts: 1, // Prevent SDK internal multi-retry hanging so our retry engine controls attempts and backoff
          httpStatusCodes: [],
        },
      },
    });

    const systemInstruction = `Kamu adalah perencana AI untuk EVEN (AI-powered personal planner).
Bahasa utama: Bahasa Indonesia baku, ringkas, objektif.
Pengguna ingin mengubah niat atau tugas menjadi jadwal realistis.

KONTEKS WAKTU PENGGUNA:
- Waktu Lokal Pengguna: ${userLocalTimeStr || currentDateTime || new Date().toISOString()}
- Zona Waktu (IANA): ${ctx.userTimezone}
- Jam Kerja Standar: ${workHours?.workStartHour || 9}:00 - ${workHours?.workEndHour || 18}:00

PENTING - ATURAN PENAFSIRAN WAKTU BAHASA INDONESIA:
1. JANGAN PERNAH menafsirkan 'malam' (contoh: 'malam ini jam 9', 'jam sembilan malam', 'pukul 21.00') sebagai pagi (09.00)!
   - 'jam 7 malam' = 19:00
   - 'jam 8 malam' = 20:00
   - 'jam 9 malam' = 21:00
   - 'jam 10 malam' = 22:00
   - 'jam 11 malam' = 23:00
   - 'jam 3 sore' = 15:00
   - 'jam 1 siang' = 13:00
2. KLASIFIKASI KONTRAK (timeConstraintType):
   a. 'fixed_event': Jika pengguna menyebutkan acara dengan waktu mulai dan selesai pasti, atau kata kerja komitmen (contoh: 'kelas dari jam 7 malam sampai jam 10 malam', 'kuliah jam 19.00 - 22.00', 'rapat besok jam 10.00-11.30').
      - requestedStartAt dan requestedEndAt HARUS diisi dalam format ISO string valid yang tepat sesuai tanggal dan jam tersebut.
      - allowSplit HARUS bernilai false (komitmen waktu tetap tidak boleh dipecah).
   b. 'preferred_window': Jika tugas memiliki jendela preferensi waktu (contoh: 'malam ini', 'besok sore jam 15-17', 'pagi hari sebelum jam 11').
      - Isi preferredWindow { startHour, endHour, label }.
      - preferredTimeOfDay: 'MORNING' | 'AFTERNOON' | 'EVENING'.
   c. 'deadline_only': Jika tugas fleksibel dan hanya dibatasi tenggat (contoh: 'laporan selesai sebelum lusa', 'baca artikel sebelum minggu').
3. Estimasi durasi (estimatedDurationMinutes) harus konsisten dengan waktu yang diminta.
4. Jangan berasumsi diam-diam bahwa waktu adalah pagi jika konteks menyebut malam atau sore.
5. Sediakan 'reasoning' singkat dalam Bahasa Indonesia yang transparan.`;

    // Execute with automatic retry on 503, 429, 500, and timeouts (max 2 retries, 14s total limit)
    const retryResult = await executeWithRetryAndTimeout(
      async (attempt, remainingMs) => {
        const perAttemptTimeoutMs = Math.min(4500, Math.max(2000, remainingMs - 500));
        const controller = new AbortController();
        const timeoutTimer = setTimeout(() => {
          controller.abort();
        }, perAttemptTimeoutMs);

        // Attempt 0 uses gemini-3.8-flash; on retries fallback to high-availability gemini-3.5-flash-lite if primary model has 503 high demand
        const model = attempt === 0 ? 'gemini-3.8-flash' : 'gemini-3.5-flash-lite';

        try {
          const result = await ai.models.generateContent({
            model,
            contents: `Tafsirkan permintaan tugas berikut ke dalam JSON schema terstruktur:\n"${trimmedPrompt}"`,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: 'Judul tugas ringkas' },
                  description: { type: Type.STRING, description: 'Deskripsi atau catatan tugas' },
                  timeConstraintType: {
                    type: Type.STRING,
                    description: "Tipe batasan waktu: 'fixed_event', 'preferred_window', atau 'deadline_only'",
                  },
                  requestedStartAt: {
                    type: Type.STRING,
                    description: 'ISO string waktu mulai jika fixed_event (contoh: 2026-10-19T19:00:00+07:00)',
                  },
                  requestedEndAt: {
                    type: Type.STRING,
                    description: 'ISO string waktu selesai jika fixed_event (contoh: 2026-10-19T22:00:00+07:00)',
                  },
                  preferredTimeOfDay: {
                    type: Type.STRING,
                    description: 'MORNING, AFTERNOON, EVENING, atau ANY',
                  },
                  estimatedDurationMinutes: { type: Type.INTEGER, description: 'Estimasi durasi dalam menit' },
                  deadlineDaysFromNow: { type: Type.INTEGER, description: 'Tenggat waktu dalam jumlah hari dari sekarang' },
                  deadlineAt: { type: Type.STRING, description: 'ISO string tenggat waktu absolut' },
                  priority: { type: Type.STRING, description: 'Prioritas: LOW, MEDIUM, HIGH, atau URGENT' },
                  allowSplit: { type: Type.BOOLEAN, description: 'Boleh dipecah beberapa sesi' },
                  minimumSessionMinutes: { type: Type.INTEGER, description: 'Durasi minimal per sesi jika dipecah' },
                  reasoning: { type: Type.STRING, description: 'Alasan rasional pemilihan durasi & struktur dalam Bahasa Indonesia' },
                },
                required: ['title', 'timeConstraintType', 'estimatedDurationMinutes', 'priority', 'allowSplit', 'reasoning'],
              },
              abortSignal: controller.signal,
            },
          });
          return result;
        } catch (err: any) {
          if (controller.signal.aborted || err?.name === 'AbortError') {
            const timeoutErr = new Error(`Permintaan ke Gemini API melampaui batas waktu percobaan (${perAttemptTimeoutMs}ms).`);
            (timeoutErr as any).name = 'AbortError';
            (timeoutErr as any).status = 504;
            throw timeoutErr;
          }
          throw err;
        } finally {
          clearTimeout(timeoutTimer);
        }
      },
      {
        maxRetries: 2,
        totalTimeoutMs: 14000,
        initialBackoffMs: 300,
        maxBackoffMs: 1200,
      }
    );

    if (retryResult.error || !retryResult.result) {
      const elapsedMs = Date.now() - startTime;
      const analysis = retryResult.analysis || classifyGeminiError(retryResult.error);
      const providerStatus = analysis.status;
      const retryCount = retryResult.retryCount;
      const category = analysis.category;

      // Diagnostics logging (duration, status, retry count, category - strictly no API key or prompt content)
      console.warn(
        `[AI Plan Diagnostics] Duration: ${elapsedMs}ms | ProviderStatus: ${providerStatus} | Retries: ${retryCount} | ErrorCategory: ${category} | ErrorCode: ${analysis.errorCode}`
      );

      return NextResponse.json(
        {
          success: false,
          errorCode: analysis.errorCode,
          error: analysis.userMessage,
          category: analysis.category,
          providerStatus,
          retryCount,
          latencyMs: elapsedMs,
        },
        { status: providerStatus }
      );
    }

    const response = retryResult.result;
    const rawPlan = JSON.parse(response.text || '{}');

    // Server-side validation and sanitization against hallucinations
    const sanitizedPlan = {
      ...rawPlan,
      timezone: ctx.userTimezone,
    };

    // HARD ANTI-REGRESSION: Never allow 9 malam / 21:00 to be saved as 09:00 morning!
    const promptLower = trimmedPrompt.toLowerCase();
    const indicatesNight = promptLower.includes('malam') || promptLower.includes('21.00') || promptLower.includes('19.00') || promptLower.includes('20.00');

    if (indicatesNight) {
      sanitizedPlan.preferredTimeOfDay = 'EVENING';
      if (sanitizedPlan.requestedStartAt) {
        const sD = new Date(sanitizedPlan.requestedStartAt);
        // If hour is morning (< 12) despite 'malam', apply baseline rule
        if (sD.getHours() < 12) {
          sanitizedPlan.requestedStartAt = baselinePlan.requestedStartAt || sanitizedPlan.requestedStartAt;
          sanitizedPlan.requestedEndAt = baselinePlan.requestedEndAt || sanitizedPlan.requestedEndAt;
        }
      }
    }

    // If baseline detected fixed event (e.g. "kelas dari jam 7 malam sampai 10 malam") but LLM missed it
    if (baselinePlan.timeConstraintType === 'fixed_event') {
      sanitizedPlan.timeConstraintType = 'fixed_event';
      sanitizedPlan.requestedStartAt = baselinePlan.requestedStartAt;
      sanitizedPlan.requestedEndAt = baselinePlan.requestedEndAt;
      sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
      sanitizedPlan.allowSplit = false;
    }

    if (baselinePlan.preferredWindow && !sanitizedPlan.preferredWindow) {
      sanitizedPlan.preferredWindow = baselinePlan.preferredWindow;
    }

    if (!sanitizedPlan.deadlineAt && baselinePlan.deadlineAt) {
      sanitizedPlan.deadlineAt = baselinePlan.deadlineAt;
    }

    const elapsedMs = Date.now() - startTime;
    console.log(
      `[AI Plan Diagnostics] Duration: ${elapsedMs}ms | ProviderStatus: 200 | Retries: ${retryResult.retryCount} | Success: true`
    );

    return NextResponse.json({
      success: true,
      isAiGenerated: true,
      source: 'gemini',
      latencyMs: elapsedMs,
      plan: sanitizedPlan,
    });
  } catch (err: any) {
    const elapsedMs = Date.now() - startTime;
    const analysis = classifyGeminiError(err);
    console.error(
      `[AI Plan Diagnostics] Unexpected failure after ${elapsedMs}ms | ProviderStatus: ${analysis.status} | Category: ${analysis.category}`
    );
    return NextResponse.json(
      {
        success: false,
        errorCode: analysis.errorCode,
        error: analysis.userMessage,
        category: analysis.category,
        providerStatus: analysis.status,
        retryCount: 0,
        latencyMs: elapsedMs,
      },
      { status: analysis.status }
    );
  }
}
