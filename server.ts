import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import {
  parseIndonesianTemporalRules,
  extractCleanActivityTitle,
  ParseContext,
} from './src/lib/temporalParser';
import {
  classifyGeminiError,
  executeWithRetryAndTimeout,
} from './src/lib/geminiErrorHandling';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

async function startServer() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Health check endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'EVEN AI Planner',
      timestamp: new Date().toISOString(),
    });
  });

  // AI Plan generation route (Express-based, Next.js removed)
  app.post('/api/gemini/plan', async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
      const { userPrompt, currentDateTime, userLocalTimeStr, userTimezone, workHours } = req.body;

      if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
        return res.status(400).json({
          success: false,
          errorCode: 'AI_INVALID_REQUEST',
          error: 'Permintaan teks tidak boleh kosong.',
        });
      }

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

      // Jika instruksi adalah intent operasional (seperti mencari slot kosong atau memindahkan jadwal bentrok)
      if (baselinePlan.isOperational) {
        const elapsedMs = Date.now() - startTime;
        console.log(`[AI Plan Diagnostics] Duration: ${elapsedMs}ms | Intent: Operational (${baselinePlan.operationalAction})`);
        return res.json({
          success: true,
          isAiGenerated: false,
          source: 'operational_intent',
          plan: baselinePlan,
        });
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        const elapsedMs = Date.now() - startTime;
        console.log(`[AI Plan Diagnostics] Duration: ${elapsedMs}ms | Mode: rule_fallback | No API key configured`);
        return res.json({
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
            attempts: 1,
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
1. JANGAN PERNAH menafsirkan 'malam' (contoh: 'malam ini jam 9', 'jam sembilan malam', 'pukul 21.00') sebagai pagi (05.00 atau 09.00)!
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
5. Sediakan 'reasoning' singkat dalam Bahasa Indonesia yang transparan.
6. JADWAL MULTI-HARI & PERULANGAN:
   - Jika pengguna menyebutkan beberapa hari (contoh: 'kelas pada Senin dan Selasa malam', 'Senin dan Rabu jam 19.00 - 21.00'), JANGAN PERNAH mengubahnya menjadi satu tugas berdurasi panjang 24 jam lebih!
   - Pisahkan menjadi daftar kejadian terpisah di 'targetOccurrences' dengan waktu mulai dan selesai per masing-masing hari.
7. PEMBUATAN JUDUL TUGAS (title):
   - Buat judul ringkas dan fokus pada inti kegiatan/subjek (contoh: 'UTS Web Programming', 'Melanjutkan Desain', 'Persiapan UTS Design', 'Rapat Koordinasi Tim').
   - JANGAN MENYALIN mentah-mentah seluruh prompt pengguna sebagai judul!`;

      const retryResult = await executeWithRetryAndTimeout(
        async (attempt, remainingMs) => {
          const perAttemptTimeoutMs = Math.min(25000, Math.max(5000, remainingMs - 500));
          const controller = new AbortController();
          const timeoutTimer = setTimeout(() => {
            controller.abort();
          }, perAttemptTimeoutMs);

          const model = attempt === 0 ? 'gemini-3.8-flash' : 'gemini-3.1-flash-lite';
          // gemini-3.8-flash tidak mendukung ThinkingLevel.MINIMAL (mengakibatkan error HTTP 400 Bad Request).
          // Gunakan ThinkingLevel.LOW untuk gemini-3.8-flash, dan ThinkingLevel.MINIMAL untuk gemini-3.1-flash-lite.
          const thinkingLevel = attempt === 0 ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL;

          try {
            const result = await ai.models.generateContent({
              model,
              contents: `Tafsirkan permintaan tugas berikut ke dalam JSON schema terstruktur:\n"${trimmedPrompt}"`,
              config: {
                systemInstruction,
                thinkingConfig: { thinkingLevel },
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
                    estimatedDurationMinutes: { type: Type.INTEGER, description: 'Estimasi durasi dalam menit per sesi' },
                    deadlineDaysFromNow: { type: Type.INTEGER, description: 'Tenggat waktu dalam jumlah hari dari sekarang' },
                    deadlineAt: { type: Type.STRING, description: 'ISO string tenggat waktu absolut' },
                    priority: { type: Type.STRING, description: 'Prioritas: LOW, MEDIUM, HIGH, atau URGENT' },
                    allowSplit: { type: Type.BOOLEAN, description: 'Boleh dipecah beberapa sesi' },
                    minimumSessionMinutes: { type: Type.INTEGER, description: 'Durasi minimal per sesi jika dipecah' },
                    targetOccurrences: {
                      type: Type.ARRAY,
                      description: 'Daftar kejadian jika pengguna menyebutkan beberapa hari (contoh: Senin dan Selasa malam)',
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          dayName: { type: Type.STRING, description: 'Nama hari (contoh: Senin, Selasa)' },
                          requestedStartAt: { type: Type.STRING, description: 'ISO string waktu mulai untuk kejadian hari ini' },
                          requestedEndAt: { type: Type.STRING, description: 'ISO string waktu selesai untuk kejadian hari ini' },
                        },
                        required: ['dayName', 'requestedStartAt', 'requestedEndAt'],
                      },
                    },
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
          maxRetries: 1,
          totalTimeoutMs: 30000,
          initialBackoffMs: 300,
          maxBackoffMs: 1000,
        }
      );

      if (retryResult.error || !retryResult.result) {
        const elapsedMs = Date.now() - startTime;
        const analysis = retryResult.analysis || classifyGeminiError(retryResult.error);
        const providerStatus = analysis.status;
        const retryCount = retryResult.retryCount;
        const category = analysis.category;

        console.log(
          `[AI Plan Diagnostics] Duration: ${elapsedMs}ms | ProviderStatus: ${providerStatus} | Retries: ${retryCount} | ErrorCategory: ${category} | ErrorCode: ${analysis.errorCode} | Fallback: rule_engine`
        );

        return res.json({
          success: true,
          isAiGenerated: false,
          source: 'rule_fallback_on_error',
          providerStatus,
          retryCount,
          latencyMs: elapsedMs,
          warning: 'Layanan AI sedang mengalami beban tinggi atau batas waktu. Rencana tugas disusun secara akurat menggunakan mesin aturan temporal deterministik EVEN.',
          plan: baselinePlan,
        });
      }

      const response = retryResult.result;
      const rawPlan = JSON.parse(response.text || '{}');

      // Server-side validation and sanitization against hallucinations
      // Anchor of Truth: The deterministic baseline overrides AI hallucinations.
      const sanitizedPlan = {
        ...rawPlan,
        timezone: ctx.userTimezone,
      };

      // 1. Time constraint type & occurrences determination:
      if (baselinePlan.targetOccurrences && baselinePlan.targetOccurrences.length > 1) {
        sanitizedPlan.timeConstraintType = 'fixed_event';
        sanitizedPlan.targetOccurrences = baselinePlan.targetOccurrences;
        sanitizedPlan.targetDays = baselinePlan.targetDays;
        sanitizedPlan.requestedStartAt = baselinePlan.targetOccurrences[0].requestedStartAt;
        sanitizedPlan.requestedEndAt = baselinePlan.targetOccurrences[0].requestedEndAt;
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
        sanitizedPlan.allowSplit = false;
      } else if (rawPlan.targetOccurrences && Array.isArray(rawPlan.targetOccurrences) && rawPlan.targetOccurrences.length > 1) {
        sanitizedPlan.timeConstraintType = 'fixed_event';
        sanitizedPlan.targetOccurrences = rawPlan.targetOccurrences;
        sanitizedPlan.requestedStartAt = rawPlan.targetOccurrences[0].requestedStartAt;
        sanitizedPlan.requestedEndAt = rawPlan.targetOccurrences[0].requestedEndAt;
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes || rawPlan.estimatedDurationMinutes;
        sanitizedPlan.allowSplit = false;
      } else if (baselinePlan.timeConstraintType === 'fixed_event') {
        sanitizedPlan.timeConstraintType = 'fixed_event';
        // Only overwrite requestedStartAt with baseline if baseline explicitly recognized a day target or AI omitted it
        if (baselinePlan.hasExplicitDayTarget || !rawPlan.requestedStartAt) {
          sanitizedPlan.requestedStartAt = baselinePlan.requestedStartAt;
          sanitizedPlan.requestedEndAt = baselinePlan.requestedEndAt;
        } else {
          sanitizedPlan.requestedStartAt = rawPlan.requestedStartAt;
          sanitizedPlan.requestedEndAt = rawPlan.requestedEndAt;
        }
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
        sanitizedPlan.allowSplit = false;
        if (baselinePlan.targetOccurrences) {
          sanitizedPlan.targetOccurrences = baselinePlan.targetOccurrences;
        }
        if (baselinePlan.targetDays) {
          sanitizedPlan.targetDays = baselinePlan.targetDays;
        }
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

      // Propagate targetDays and targetOccurrences deterministically from baseline
      if (baselinePlan.targetDays && baselinePlan.targetDays.length > 0) {
        sanitizedPlan.targetDays = baselinePlan.targetDays;
      }
      if (baselinePlan.targetOccurrences && baselinePlan.targetOccurrences.length > 0) {
        sanitizedPlan.targetOccurrences = baselinePlan.targetOccurrences;
      }

      // 2. Preferred time of day
      if (baselinePlan.preferredTimeOfDay !== 'ANY') {
        sanitizedPlan.preferredTimeOfDay = baselinePlan.preferredTimeOfDay;
      }

      // 3. Duration validation
      const promptHasExplicitDuration =
        /(\d+)\s*(?:menit|mnt|jam)/i.test(trimmedPrompt) ||
        /(?:selama\s+)?(se|satu|dua|tiga|empat|lima|enam|tujuh|delapan)\s*jam/i.test(trimmedPrompt) ||
        /\b(sejam|setengah jam)\b/i.test(trimmedPrompt) ||
        /(?:tiga puluh|empat puluh lima|sembilan puluh)\s*(?:menit|mnt)/i.test(trimmedPrompt);

      if (
        (promptHasExplicitDuration || (baselinePlan.estimatedDurationMinutes && baselinePlan.estimatedDurationMinutes !== 60)) &&
        baselinePlan.estimatedDurationMinutes
      ) {
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
      } else if (!sanitizedPlan.estimatedDurationMinutes || sanitizedPlan.estimatedDurationMinutes <= 0) {
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes || 60;
      }

      // 4. Preferred window
      if (baselinePlan.preferredWindow) {
        sanitizedPlan.preferredWindow = baselinePlan.preferredWindow;
      }

      // 5. Deadline sanitization
      // Hanya izinkan deadline jika aturan deterministik mendeteksi tenggat eksplisit dari instruksi pengguna.
      // Jika pengguna tidak menyebutkan tenggat, pastikan deadlineAt dihapus agar AI tidak berhalusinasi.
      if (baselinePlan.deadlineAt) {
        sanitizedPlan.deadlineAt = baselinePlan.deadlineAt;
        sanitizedPlan.deadlineDaysFromNow = baselinePlan.deadlineDaysFromNow;
      } else {
        delete sanitizedPlan.deadlineAt;
        delete sanitizedPlan.deadlineDaysFromNow;
      }

      // 5b. Multi-day explicit reasoning override and duration ambiguity
      if (baselinePlan.targetDays && baselinePlan.targetDays.length > 1) {
        sanitizedPlan.reasoning = baselinePlan.reasoning;
        sanitizedPlan.isDurationAmbiguous = baselinePlan.isDurationAmbiguous;
        sanitizedPlan.totalDurationMinutes = baselinePlan.totalDurationMinutes;
        sanitizedPlan.durationPerDayMinutes = baselinePlan.durationPerDayMinutes;
        sanitizedPlan.clarificationPrompt = baselinePlan.clarificationPrompt;
      }

      // 6. Title and Description Sanitization:
      // Pastikan judul ringkas dan tidak pernah menyalin mentah seluruh prompt
      sanitizedPlan.title = extractCleanActivityTitle(trimmedPrompt, rawPlan.title || baselinePlan.title);
      if (!sanitizedPlan.description || sanitizedPlan.description.trim() === '') {
        sanitizedPlan.description = `Catatan asli: "${trimmedPrompt}"`;
      } else if (!sanitizedPlan.description.includes(trimmedPrompt)) {
        sanitizedPlan.description = `${sanitizedPlan.description}\nCatatan asli: "${trimmedPrompt}"`;
      }

      const elapsedMs = Date.now() - startTime;
      console.log(
        `[AI Plan Diagnostics] Duration: ${elapsedMs}ms | ProviderStatus: 200 | Retries: ${retryResult.retryCount} | Success: true`
      );

      return res.json({
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
      return res.status(analysis.status).json({
        success: false,
        errorCode: analysis.errorCode,
        error: analysis.userMessage,
        category: analysis.category,
        providerStatus: analysis.status,
        retryCount: 0,
        latencyMs: elapsedMs,
      });
    }
  });

  // Serve Frontend Assets: Vite middleware in dev, static files in production
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.use((_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 EVEN AI Planner Server running on http://0.0.0.0:${PORT} (Mode: ${isProduction ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
