// server.ts
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

// src/lib/timezone.ts
function parseTimezoneString(tz) {
  if (!tz) return "Asia/Jakarta";
  if (tz.includes("Asia/Jakarta") || tz.includes("WIB")) return "Asia/Jakarta";
  if (tz.includes("Asia/Makassar") || tz.includes("WITA")) return "Asia/Makassar";
  if (tz.includes("Asia/Jayapura") || tz.includes("WIT")) return "Asia/Jayapura";
  if (tz.includes("UTC")) return "UTC";
  return tz.split(" ")[0] || "Asia/Jakarta";
}
function getTimezoneOffsetMinutes(timeZone = "Asia/Jakarta", date = /* @__PURE__ */ new Date()) {
  const cleanTz = parseTimezoneString(timeZone);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: cleanTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const getPart = (type) => parseInt(parts.find((p) => p.type === type)?.value || "0", 10);
    const year = getPart("year");
    const month = getPart("month");
    const day = getPart("day");
    let hour = getPart("hour");
    if (hour === 24) hour = 0;
    const minute = getPart("minute");
    const second = getPart("second");
    const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return Math.round((asUtc - date.getTime()) / 6e4);
  } catch {
    if (cleanTz === "Asia/Makassar") return 480;
    if (cleanTz === "Asia/Jayapura") return 540;
    if (cleanTz === "UTC") return 0;
    return 420;
  }
}
function getPartsInTimezone(date, timeZone = "Asia/Jakarta") {
  const cleanTz = parseTimezoneString(timeZone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: cleanTz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type) => parts.find((p) => p.type === type)?.value || "0";
  let hour = parseInt(getPart("hour"), 10);
  if (hour === 24) hour = 0;
  const weekdayStr = (getPart("weekday") || "").toLowerCase();
  const daysMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const dayOfWeek = daysMap[weekdayStr] ?? date.getDay();
  return {
    year: parseInt(getPart("year"), 10),
    month: parseInt(getPart("month"), 10),
    day: parseInt(getPart("day"), 10),
    hour,
    minute: parseInt(getPart("minute"), 10),
    second: parseInt(getPart("second"), 10),
    dayOfWeek
  };
}
function createIsoInTimezone(year, month, day, hour, minute = 0, second = 0, timeZone = "Asia/Jakarta") {
  const cleanTz = parseTimezoneString(timeZone);
  const roughUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimezoneOffsetMinutes(cleanTz, roughUtc);
  const exactUtcMs = roughUtc.getTime() - offsetMinutes * 60 * 1e3;
  return new Date(exactUtcMs).toISOString();
}

// src/lib/temporalParser.ts
function parseIndonesianTemporalRules(ctx) {
  const prompt = ctx.userPrompt.trim().toLowerCase();
  const tz = parseTimezoneString(ctx.userTimezone || "Asia/Jakarta");
  const baseDate = ctx.currentDateTime ? new Date(ctx.currentDateTime) : /* @__PURE__ */ new Date();
  const baseParts = getPartsInTimezone(baseDate, tz);
  let dayOffset = 0;
  if (prompt.includes("besok lusa")) {
    dayOffset = 2;
  } else if (prompt.includes("lusa")) {
    dayOffset = 2;
  } else if (prompt.includes("besok")) {
    dayOffset = 1;
  } else if (prompt.includes("3 hari lagi")) {
    dayOffset = 3;
  } else if (prompt.includes("minggu depan")) {
    dayOffset = 7;
  }
  const targetDateObj = new Date(baseDate.getTime() + dayOffset * 864e5);
  const targetParts = getPartsInTimezone(targetDateObj, tz);
  const isCommitmentKeyword = /\b(kelas|kuliah|webinar|rapat|meeting|janji|jadwal|workshop|seminar|konsultasi|kursus)\b/i.test(prompt);
  let fixedStartHour = null;
  let fixedStartMin = 0;
  let fixedEndHour = null;
  let fixedEndMin = 0;
  let hasExplicitRange = false;
  const colonRangeMatch = prompt.match(/(?:pukul|jam)?\s*(\d{1,2})[:.](\d{2})\s*(?:-|–|sampai|s\/d|hingga)\s*(?:pukul|jam)?\s*(\d{1,2})[:.](\d{2})/i);
  if (colonRangeMatch) {
    fixedStartHour = parseInt(colonRangeMatch[1], 10);
    fixedStartMin = parseInt(colonRangeMatch[2], 10);
    fixedEndHour = parseInt(colonRangeMatch[3], 10);
    fixedEndMin = parseInt(colonRangeMatch[4], 10);
    hasExplicitRange = true;
  }
  if (fixedStartHour === null) {
    const wordRangeMatch = prompt.match(/(?:dari\s+)?(?:jam|pukul)\s*(\d{1,2})(?::(\d{2}))?\s*(pagi|siang|sore|malam)?\s*(?:sampai|hingga|s\/d|-|–)\s*(?:jam|pukul)?\s*(\d{1,2})(?::(\d{2}))?\s*(pagi|siang|sore|malam)?/i);
    if (wordRangeMatch) {
      let sH = parseInt(wordRangeMatch[1], 10);
      const sM = wordRangeMatch[2] ? parseInt(wordRangeMatch[2], 10) : 0;
      const sPeriod = wordRangeMatch[3];
      let eH = parseInt(wordRangeMatch[4], 10);
      const eM = wordRangeMatch[5] ? parseInt(wordRangeMatch[5], 10) : 0;
      const ePeriod = wordRangeMatch[6] || sPeriod;
      const overallIsNight = ePeriod === "malam" || sPeriod === "malam" || prompt.includes("malam");
      const overallIsAfternoon = ePeriod === "sore" || sPeriod === "sore" || prompt.includes("sore");
      const overallIsNoon = ePeriod === "siang" || sPeriod === "siang" || prompt.includes("siang");
      if (overallIsNight) {
        if (sH < 12) sH += 12;
        if (eH < 12) eH += 12;
      } else if (overallIsAfternoon) {
        if (sH <= 6) sH += 12;
        if (eH <= 6) eH += 12;
      } else if (overallIsNoon) {
        if (sH >= 1 && sH <= 3) sH += 12;
        if (eH >= 1 && eH <= 3) eH += 12;
      }
      fixedStartHour = sH;
      fixedStartMin = sM;
      fixedEndHour = eH;
      fixedEndMin = eM;
      hasExplicitRange = true;
    }
  }
  let hasExplicitExactTime = false;
  if (fixedStartHour === null) {
    const singleTimeMatch = prompt.match(/(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?/i);
    if (singleTimeMatch) {
      let h = parseInt(singleTimeMatch[1], 10);
      const m = singleTimeMatch[2] ? parseInt(singleTimeMatch[2], 10) : 0;
      const period = singleTimeMatch[3];
      const isNight = period === "malam" || prompt.includes("malam");
      const isAfternoon = period === "sore" || prompt.includes("sore");
      const isNoon = period === "siang" || prompt.includes("siang");
      if (isNight && h < 12) {
        h += 12;
      } else if (isAfternoon && h <= 6) {
        h += 12;
      } else if (isNoon && h >= 1 && h <= 3) {
        h += 12;
      }
      fixedStartHour = h;
      fixedStartMin = m;
      hasExplicitExactTime = true;
    } else {
      if (prompt.includes("sembilan malam") || prompt.includes("9 malam")) {
        fixedStartHour = 21;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      } else if (prompt.includes("tujuh malam") || prompt.includes("7 malam")) {
        fixedStartHour = 19;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      } else if (prompt.includes("delapan malam") || prompt.includes("8 malam")) {
        fixedStartHour = 20;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      } else if (prompt.includes("sepuluh malam") || prompt.includes("10 malam")) {
        fixedStartHour = 22;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      }
    }
  }
  let duration = 60;
  const durMatch = prompt.match(/(\d+)\s*(?:menit|mnt|jam)/i);
  if (durMatch) {
    const val = parseInt(durMatch[1], 10);
    if (prompt.includes(`${val} jam`)) {
      duration = val * 60;
    } else {
      duration = val;
    }
  } else if (fixedStartHour !== null && fixedEndHour !== null) {
    let startTotal = fixedStartHour * 60 + fixedStartMin;
    let endTotal = fixedEndHour * 60 + fixedEndMin;
    if (endTotal < startTotal) {
      endTotal += 24 * 60;
    }
    if (endTotal > startTotal) {
      duration = endTotal - startTotal;
    }
  } else if (prompt.includes("tidur") && !durMatch) {
    duration = 480;
  }
  if (fixedStartHour !== null && fixedEndHour === null) {
    const startTotal = fixedStartHour * 60 + fixedStartMin;
    const endTotal = startTotal + duration;
    fixedEndHour = Math.floor(endTotal / 60) % 24;
    fixedEndMin = endTotal % 60;
  }
  let timeConstraintType = "deadline_only";
  let requestedStartAt = void 0;
  let requestedEndAt = void 0;
  let preferredWindow = void 0;
  let preferredTimeOfDay = "ANY";
  const isFlexibleLearningOrTask = /\b(belajar|kerja|mengerjakan|tugas|baca|membaca|fokus|cicil)\b/i.test(prompt);
  const isExactFixedEvent = fixedStartHour !== null && (hasExplicitRange || isCommitmentKeyword || !isFlexibleLearningOrTask && (prompt.includes("pukul") || prompt.includes("jam")) || prompt.includes("tidur pukul") || prompt.includes("tidur jam"));
  if (isExactFixedEvent && fixedStartHour !== null) {
    timeConstraintType = "fixed_event";
    requestedStartAt = createIsoInTimezone(
      targetParts.year,
      targetParts.month,
      targetParts.day,
      fixedStartHour,
      fixedStartMin,
      0,
      tz
    );
    const startDateObj = new Date(requestedStartAt);
    const endDateObj = new Date(startDateObj.getTime() + duration * 6e4);
    requestedEndAt = endDateObj.toISOString();
    preferredTimeOfDay = fixedStartHour >= 18 ? "EVENING" : fixedStartHour >= 12 ? "AFTERNOON" : "MORNING";
  } else if (fixedStartHour !== null) {
    timeConstraintType = "preferred_window";
    const windowEndHour = Math.min(23, fixedStartHour + Math.ceil(duration / 60) + 1);
    preferredWindow = {
      startHour: fixedStartHour,
      startMinute: fixedStartMin,
      endHour: windowEndHour,
      endMinute: 0,
      label: `Malam (${String(fixedStartHour).padStart(2, "0")}:${String(fixedStartMin).padStart(2, "0")} - ${String(windowEndHour).padStart(2, "0")}:00)`
    };
    preferredTimeOfDay = fixedStartHour >= 18 ? "EVENING" : fixedStartHour >= 12 ? "AFTERNOON" : "MORNING";
    requestedStartAt = createIsoInTimezone(
      targetParts.year,
      targetParts.month,
      targetParts.day,
      fixedStartHour,
      fixedStartMin,
      0,
      tz
    );
  } else if (prompt.includes("malam")) {
    timeConstraintType = "preferred_window";
    preferredWindow = { startHour: 19, startMinute: 0, endHour: 23, endMinute: 0, label: "Malam (19:00 - 23:00)" };
    preferredTimeOfDay = "EVENING";
    requestedStartAt = void 0;
    requestedEndAt = void 0;
  } else if (prompt.includes("sore")) {
    timeConstraintType = "preferred_window";
    preferredWindow = { startHour: 15, startMinute: 0, endHour: 18, endMinute: 0, label: "Sore (15:00 - 18:00)" };
    preferredTimeOfDay = "AFTERNOON";
    requestedStartAt = void 0;
    requestedEndAt = void 0;
  } else if (prompt.includes("siang")) {
    timeConstraintType = "preferred_window";
    preferredWindow = { startHour: 13, startMinute: 0, endHour: 15, endMinute: 0, label: "Siang (13:00 - 15:00)" };
    preferredTimeOfDay = "AFTERNOON";
    requestedStartAt = void 0;
    requestedEndAt = void 0;
  } else if (prompt.includes("pagi")) {
    timeConstraintType = "preferred_window";
    preferredWindow = { startHour: 6, startMinute: 0, endHour: 12, endMinute: 0, label: "Pagi (06:00 - 12:00)" };
    preferredTimeOfDay = "MORNING";
    requestedStartAt = void 0;
    requestedEndAt = void 0;
  }
  let deadlineIso;
  if (timeConstraintType === "fixed_event" && requestedEndAt) {
    deadlineIso = requestedEndAt;
  } else {
    const deadlineHour = preferredTimeOfDay === "EVENING" ? 23 : 18;
    deadlineIso = createIsoInTimezone(
      targetParts.year,
      targetParts.month,
      targetParts.day,
      deadlineHour,
      0,
      0,
      tz
    );
  }
  let priority = "MEDIUM";
  if (prompt.includes("urgent") || prompt.includes("segera") || prompt.includes("penting sekali")) {
    priority = "URGENT";
  } else if (prompt.includes("tinggi") || prompt.includes("prioritas") || isCommitmentKeyword) {
    priority = "HIGH";
  } else if (prompt.includes("santai") || prompt.includes("low")) {
    priority = "LOW";
  }
  const allowSplit = timeConstraintType !== "fixed_event" && (prompt.includes("bagi") || prompt.includes("sesi") || prompt.includes("cicil"));
  const minSession = 30;
  let title = ctx.userPrompt.trim();
  if (title.length > 50) {
    title = title.slice(0, 47) + "...";
  }
  let reasoning = "";
  if (timeConstraintType === "fixed_event") {
    reasoning = `AI mendeteksi komitmen waktu tetap (${fixedStartHour ? String(fixedStartHour).padStart(2, "0") : "00"}:${String(fixedStartMin).padStart(2, "0")} - ${fixedEndHour ? String(fixedEndHour).padStart(2, "0") : "00"}:${String(fixedEndMin).padStart(2, "0")}) sehingga dijaga tanpa digeser.`;
  } else if (preferredWindow) {
    reasoning = `AI menetapkan jendela preferensi ${preferredWindow.label} dengan durasi ${duration} menit agar sesuai dengan waktu ${preferredTimeOfDay === "EVENING" ? "santai atau fokus malam" : preferredTimeOfDay.toLowerCase()} Anda.`;
  } else {
    reasoning = `AI menetapkan estimasi durasi ${duration} menit dengan tenggat waktu ${dayOffset === 0 ? "hari ini" : `${dayOffset} hari ke depan`}.`;
  }
  return {
    title,
    description: `Catatan asli: "${ctx.userPrompt}"`,
    estimatedDurationMinutes: duration,
    timeConstraintType,
    requestedStartAt,
    requestedEndAt,
    preferredWindow,
    preferredTimeOfDay,
    deadlineAt: deadlineIso,
    deadlineDaysFromNow: Math.max(1, dayOffset),
    timezone: tz,
    priority,
    allowSplit,
    minimumSessionMinutes: minSession,
    reasoning
  };
}

// src/lib/geminiErrorHandling.ts
function classifyGeminiError(err) {
  let status = 500;
  const msg = String(err?.message || "");
  const errCode = String(err?.code || "");
  const name = String(err?.name || "");
  if (typeof err?.status === "number" && err.status >= 400 && err.status < 600) {
    status = err.status;
  } else if (typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600) {
    status = err.statusCode;
  } else if (typeof err?.response?.status === "number" && err.response.status >= 400 && err.response.status < 600) {
    status = err.response.status;
  } else if (/\b503\b|UNAVAILABLE|overloaded|high demand|temporarily unavailable/i.test(msg) || errCode === "UNAVAILABLE") {
    status = 503;
  } else if (/\b429\b|RESOURCE_EXHAUSTED|rate limit|quota|too many requests/i.test(msg) || errCode === "RESOURCE_EXHAUSTED") {
    status = 429;
  } else if (/\b401\b|UNAUTHENTICATED|API_KEY_INVALID|invalid api key/i.test(msg) || errCode === "UNAUTHENTICATED") {
    status = 401;
  } else if (/\b403\b|PERMISSION_DENIED|forbidden/i.test(msg) || errCode === "PERMISSION_DENIED") {
    status = 403;
  } else if (/\b400\b|INVALID_ARGUMENT|bad request/i.test(msg) || errCode === "INVALID_ARGUMENT") {
    status = 400;
  } else if (/\b504\b|DEADLINE_EXCEEDED|timeout|timed out/i.test(msg) || name === "AbortError" || errCode === "DEADLINE_EXCEEDED") {
    status = 504;
  } else if (/\b502\b|bad gateway/i.test(msg)) {
    status = 502;
  }
  if (status === 503) {
    return {
      status: 503,
      category: "transient_unavailable",
      isRetryable: true,
      errorCode: "AI_TEMPORARILY_UNAVAILABLE",
      userMessage: "Layanan AI sedang sibuk. Permintaan Anda belum diproses. Silakan coba lagi."
    };
  }
  if (status === 429) {
    return {
      status: 429,
      category: "rate_limited",
      isRetryable: true,
      errorCode: "AI_RATE_LIMIT_EXCEEDED",
      userMessage: "Layanan AI sedang sibuk karena banyaknya permintaan. Silakan tunggu sebentar dan coba lagi."
    };
  }
  if (status === 504 || name === "AbortError" || /timeout|timed out/i.test(msg)) {
    return {
      status: 504,
      category: "timeout",
      isRetryable: true,
      errorCode: "AI_TIMEOUT",
      userMessage: "Permintaan ke layanan AI melampaui batas waktu. Silakan coba lagi."
    };
  }
  if (status === 401) {
    return {
      status: 401,
      category: "auth_error",
      isRetryable: false,
      errorCode: "AI_AUTH_FAILED",
      userMessage: "Autentikasi ke layanan AI gagal. Periksa konfigurasi API key server."
    };
  }
  if (status === 403) {
    return {
      status: 403,
      category: "permission_denied",
      isRetryable: false,
      errorCode: "AI_PERMISSION_DENIED",
      userMessage: "Akses ke model AI ditolak oleh penyedia layanan."
    };
  }
  if (status === 400) {
    return {
      status: 400,
      category: "invalid_request",
      isRetryable: false,
      errorCode: "AI_INVALID_REQUEST",
      userMessage: "Format permintaan tidak dapat diproses oleh AI."
    };
  }
  if (status === 500 || status === 502) {
    return {
      status,
      category: "internal_error",
      isRetryable: true,
      errorCode: "AI_SERVICE_ERROR",
      userMessage: "Terjadi gangguan sementara pada server penyedia AI. Silakan coba lagi."
    };
  }
  return {
    status,
    category: "internal_error",
    isRetryable: false,
    errorCode: "AI_UNKNOWN_ERROR",
    userMessage: "Gagal memproses permintaan dengan AI. Silakan coba lagi."
  };
}
function calculateBackoffWithJitter(attempt, initialBackoffMs = 400, maxBackoffMs = 2e3) {
  const expFactor = Math.pow(2, Math.max(0, attempt - 1));
  const baseMs = Math.min(maxBackoffMs, initialBackoffMs * expFactor);
  const jitterFactor = 0.5 + Math.random();
  return Math.round(baseMs * jitterFactor);
}
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function executeWithRetryAndTimeout(operation, options = {}) {
  const maxRetries = options.maxRetries ?? 2;
  const totalTimeoutMs = options.totalTimeoutMs ?? 16e3;
  const initialBackoffMs = options.initialBackoffMs ?? 400;
  const maxBackoffMs = options.maxBackoffMs ?? 2e3;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const nowFn = options.nowFn ?? Date.now;
  const startTime = nowFn();
  let lastError = null;
  let lastAnalysis = {
    status: 500,
    category: "internal_error",
    isRetryable: false,
    errorCode: "AI_UNKNOWN_ERROR",
    userMessage: "Gagal memproses permintaan dengan AI."
  };
  let attemptsExecuted = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const elapsed = nowFn() - startTime;
    const remainingMs = totalTimeoutMs - elapsed;
    if (remainingMs <= 500) {
      lastError = new Error("Batas waktu total permintaan AI terlampaui.");
      lastAnalysis = classifyGeminiError(lastError);
      break;
    }
    attemptsExecuted = attempt + 1;
    try {
      const result = await operation(attempt, remainingMs);
      return {
        result,
        attempts: attemptsExecuted,
        retryCount: attempt,
        elapsedMs: nowFn() - startTime
      };
    } catch (err) {
      lastError = err;
      lastAnalysis = classifyGeminiError(err);
      if (!lastAnalysis.isRetryable) {
        break;
      }
      if (attempt >= maxRetries) {
        break;
      }
      const backoffMs = calculateBackoffWithJitter(attempt + 1, initialBackoffMs, maxBackoffMs);
      const postBackoffElapsed = nowFn() - startTime + backoffMs;
      if (postBackoffElapsed + 800 > totalTimeoutMs) {
        break;
      }
      await sleepFn(backoffMs);
    }
  }
  return {
    error: lastError,
    analysis: lastAnalysis,
    attempts: attemptsExecuted,
    retryCount: Math.max(0, attemptsExecuted - 1),
    elapsedMs: nowFn() - startTime
  };
}

// server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var isProduction = process.env.NODE_ENV === "production";
var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3e3;
async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "EVEN AI Planner",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  });
  app.post("/api/gemini/plan", async (req, res) => {
    const startTime = Date.now();
    try {
      const { userPrompt, currentDateTime, userLocalTimeStr, userTimezone, workHours } = req.body;
      if (!userPrompt || typeof userPrompt !== "string" || !userPrompt.trim()) {
        return res.status(400).json({
          success: false,
          errorCode: "AI_INVALID_REQUEST",
          error: "Permintaan teks tidak boleh kosong."
        });
      }
      const trimmedPrompt = userPrompt.trim().slice(0, 600);
      const ctx = {
        userPrompt: trimmedPrompt,
        currentDateTime: currentDateTime || (/* @__PURE__ */ new Date()).toISOString(),
        userLocalTimeStr,
        userTimezone: userTimezone || "Asia/Jakarta",
        workHours
      };
      const baselinePlan = parseIndonesianTemporalRules(ctx);
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        const elapsedMs2 = Date.now() - startTime;
        console.log(`[AI Plan Diagnostics] Duration: ${elapsedMs2}ms | Mode: rule_fallback | No API key configured`);
        return res.json({
          success: true,
          isAiGenerated: false,
          source: "rule_fallback",
          warning: "Kunci GEMINI_API_KEY tidak tersedia di server. Menggunakan sistem aturan temporal deterministik EVEN.",
          plan: baselinePlan
        });
      }
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build"
          },
          retryOptions: {
            attempts: 1,
            httpStatusCodes: []
          }
        }
      });
      const systemInstruction = `Kamu adalah perencana AI untuk EVEN (AI-powered personal planner).
Bahasa utama: Bahasa Indonesia baku, ringkas, objektif.
Pengguna ingin mengubah niat atau tugas menjadi jadwal realistis.

KONTEKS WAKTU PENGGUNA:
- Waktu Lokal Pengguna: ${userLocalTimeStr || currentDateTime || (/* @__PURE__ */ new Date()).toISOString()}
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
5. Sediakan 'reasoning' singkat dalam Bahasa Indonesia yang transparan.`;
      const retryResult = await executeWithRetryAndTimeout(
        async (attempt, remainingMs) => {
          const perAttemptTimeoutMs = Math.min(25e3, Math.max(5e3, remainingMs - 500));
          const controller = new AbortController();
          const timeoutTimer = setTimeout(() => {
            controller.abort();
          }, perAttemptTimeoutMs);
          const model = attempt === 0 ? "gemini-3.8-flash" : "gemini-3.1-flash-lite";
          const thinkingLevel = ThinkingLevel.MINIMAL;
          try {
            const result = await ai.models.generateContent({
              model,
              contents: `Tafsirkan permintaan tugas berikut ke dalam JSON schema terstruktur:
"${trimmedPrompt}"`,
              config: {
                systemInstruction,
                thinkingConfig: { thinkingLevel },
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING, description: "Judul tugas ringkas" },
                    description: { type: Type.STRING, description: "Deskripsi atau catatan tugas" },
                    timeConstraintType: {
                      type: Type.STRING,
                      description: "Tipe batasan waktu: 'fixed_event', 'preferred_window', atau 'deadline_only'"
                    },
                    requestedStartAt: {
                      type: Type.STRING,
                      description: "ISO string waktu mulai jika fixed_event (contoh: 2026-10-19T19:00:00+07:00)"
                    },
                    requestedEndAt: {
                      type: Type.STRING,
                      description: "ISO string waktu selesai jika fixed_event (contoh: 2026-10-19T22:00:00+07:00)"
                    },
                    preferredTimeOfDay: {
                      type: Type.STRING,
                      description: "MORNING, AFTERNOON, EVENING, atau ANY"
                    },
                    estimatedDurationMinutes: { type: Type.INTEGER, description: "Estimasi durasi dalam menit" },
                    deadlineDaysFromNow: { type: Type.INTEGER, description: "Tenggat waktu dalam jumlah hari dari sekarang" },
                    deadlineAt: { type: Type.STRING, description: "ISO string tenggat waktu absolut" },
                    priority: { type: Type.STRING, description: "Prioritas: LOW, MEDIUM, HIGH, atau URGENT" },
                    allowSplit: { type: Type.BOOLEAN, description: "Boleh dipecah beberapa sesi" },
                    minimumSessionMinutes: { type: Type.INTEGER, description: "Durasi minimal per sesi jika dipecah" },
                    reasoning: { type: Type.STRING, description: "Alasan rasional pemilihan durasi & struktur dalam Bahasa Indonesia" }
                  },
                  required: ["title", "timeConstraintType", "estimatedDurationMinutes", "priority", "allowSplit", "reasoning"]
                },
                abortSignal: controller.signal
              }
            });
            return result;
          } catch (err) {
            if (controller.signal.aborted || err?.name === "AbortError") {
              const timeoutErr = new Error(`Permintaan ke Gemini API melampaui batas waktu percobaan (${perAttemptTimeoutMs}ms).`);
              timeoutErr.name = "AbortError";
              timeoutErr.status = 504;
              throw timeoutErr;
            }
            throw err;
          } finally {
            clearTimeout(timeoutTimer);
          }
        },
        {
          maxRetries: 1,
          totalTimeoutMs: 3e4,
          initialBackoffMs: 300,
          maxBackoffMs: 1e3
        }
      );
      if (retryResult.error || !retryResult.result) {
        const elapsedMs2 = Date.now() - startTime;
        const analysis = retryResult.analysis || classifyGeminiError(retryResult.error);
        const providerStatus = analysis.status;
        const retryCount = retryResult.retryCount;
        const category = analysis.category;
        console.log(
          `[AI Plan Diagnostics] Duration: ${elapsedMs2}ms | ProviderStatus: ${providerStatus} | Retries: ${retryCount} | ErrorCategory: ${category} | ErrorCode: ${analysis.errorCode} | Fallback: rule_engine`
        );
        return res.json({
          success: true,
          isAiGenerated: false,
          source: "rule_fallback_on_error",
          providerStatus,
          retryCount,
          latencyMs: elapsedMs2,
          warning: "Layanan AI sedang mengalami beban tinggi atau batas waktu. Rencana tugas disusun secara akurat menggunakan mesin aturan temporal deterministik EVEN.",
          plan: baselinePlan
        });
      }
      const response = retryResult.result;
      const rawPlan = JSON.parse(response.text || "{}");
      const sanitizedPlan = {
        ...rawPlan,
        timezone: ctx.userTimezone
      };
      if (baselinePlan.timeConstraintType === "fixed_event") {
        sanitizedPlan.timeConstraintType = "fixed_event";
        sanitizedPlan.requestedStartAt = baselinePlan.requestedStartAt;
        sanitizedPlan.requestedEndAt = baselinePlan.requestedEndAt;
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
        sanitizedPlan.allowSplit = false;
      } else if (baselinePlan.timeConstraintType === "preferred_window") {
        sanitizedPlan.timeConstraintType = "preferred_window";
        sanitizedPlan.preferredWindow = baselinePlan.preferredWindow;
        sanitizedPlan.preferredTimeOfDay = baselinePlan.preferredTimeOfDay;
        delete sanitizedPlan.requestedStartAt;
        delete sanitizedPlan.requestedEndAt;
      } else {
        sanitizedPlan.timeConstraintType = "deadline_only";
        delete sanitizedPlan.requestedStartAt;
        delete sanitizedPlan.requestedEndAt;
      }
      if (baselinePlan.preferredTimeOfDay !== "ANY") {
        sanitizedPlan.preferredTimeOfDay = baselinePlan.preferredTimeOfDay;
      }
      const promptHasExplicitDuration = /(\d+)\s*(?:menit|mnt|jam)/i.test(trimmedPrompt);
      if (promptHasExplicitDuration && baselinePlan.estimatedDurationMinutes) {
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
      } else if (!sanitizedPlan.estimatedDurationMinutes || sanitizedPlan.estimatedDurationMinutes <= 0) {
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes || 60;
      }
      if (baselinePlan.preferredWindow) {
        sanitizedPlan.preferredWindow = baselinePlan.preferredWindow;
      }
      if (baselinePlan.deadlineAt) {
        sanitizedPlan.deadlineAt = baselinePlan.deadlineAt;
        sanitizedPlan.deadlineDaysFromNow = baselinePlan.deadlineDaysFromNow;
      }
      const elapsedMs = Date.now() - startTime;
      console.log(
        `[AI Plan Diagnostics] Duration: ${elapsedMs}ms | ProviderStatus: 200 | Retries: ${retryResult.retryCount} | Success: true`
      );
      return res.json({
        success: true,
        isAiGenerated: true,
        source: "gemini",
        latencyMs: elapsedMs,
        plan: sanitizedPlan
      });
    } catch (err) {
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
        latencyMs: elapsedMs
      });
    }
  });
  if (!isProduction) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.resolve(distPath, "index.html"));
    });
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\u{1F680} EVEN AI Planner Server running on http://0.0.0.0:${PORT} (Mode: ${isProduction ? "production" : "development"})`);
  });
}
startServer().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
