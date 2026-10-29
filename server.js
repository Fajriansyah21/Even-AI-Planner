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
function addDaysInTimezone(date, days, timeZone = "Asia/Jakarta") {
  const cleanTz = parseTimezoneString(timeZone);
  const parts = getPartsInTimezone(date, cleanTz);
  const utcCalc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second));
  const newYear = utcCalc.getUTCFullYear();
  const newMonth = utcCalc.getUTCMonth() + 1;
  const newDay = utcCalc.getUTCDate();
  const iso = createIsoInTimezone(newYear, newMonth, newDay, parts.hour, parts.minute, parts.second, cleanTz);
  return new Date(iso);
}

// src/lib/temporalParser.ts
var INDONESIAN_WEEKDAYS = [
  { name: "minggu", dayIndex: 0 },
  { name: "ahad", dayIndex: 0 },
  { name: "senin", dayIndex: 1 },
  { name: "selasa", dayIndex: 2 },
  { name: "rabu", dayIndex: 3 },
  { name: "kamis", dayIndex: 4 },
  { name: "jumat", dayIndex: 5 },
  { name: "jum'at", dayIndex: 5 },
  { name: "sabtu", dayIndex: 6 }
];
var DAY_NAMES_ID = {
  0: "Minggu",
  1: "Senin",
  2: "Selasa",
  3: "Rabu",
  4: "Kamis",
  5: "Jumat",
  6: "Sabtu"
};
function toTitleCase(str) {
  const acronyms = /* @__PURE__ */ new Set([
    "UTS",
    "UAS",
    "PR",
    "UI",
    "UX",
    "UI/UX",
    "API",
    "AI",
    "HTML",
    "CSS",
    "SQL",
    "WIB",
    "WITA",
    "WIT",
    "GBK",
    "IT",
    "QA",
    "CRUD",
    "MVP",
    "SDK"
  ]);
  return str.split(/\s+/).filter(Boolean).map((word) => {
    const upper = word.toUpperCase();
    if (acronyms.has(upper)) return upper;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(" ");
}
function extractCleanActivityTitle(prompt, aiTitle) {
  if (aiTitle && typeof aiTitle === "string") {
    const trimmedAi = aiTitle.trim();
    const promptTrimmed = prompt.trim();
    if (trimmedAi.length >= 3 && trimmedAi.length <= 60 && trimmedAi.toLowerCase() !== promptTrimmed.toLowerCase() && !/^(?:tolong\s+)?(?:jadwalkan|masukkan|buatkan|bikin\s+jadwal)\b/i.test(trimmedAi)) {
      return trimmedAi;
    }
  }
  const raw = prompt.trim();
  const examDeadlineMatch = raw.match(
    /\b(?:ada\s+)?(UTS|UAS|ujian|tugas|kuis|quiz)\s+([A-Za-z0-9\s/]+?)(?:\s+(?:deadline[-a-zA-Z0-9]*|tenggat|paling lambat).*|$)/i
  );
  if (examDeadlineMatch && /\b(deadline|tenggat|paling lambat)\b/i.test(raw)) {
    const examType = examDeadlineMatch[1].toUpperCase();
    let subject = examDeadlineMatch[2].trim();
    if (subject.toLowerCase() === "design") subject = "Design";
    return `Persiapan ${examType} ${toTitleCase(subject)}`;
  }
  const continueMatch = raw.match(
    /\b(?:lanjut|melanjutkan)\s+(?:ngerjain|mengerjakan|bikin|buat|kerja(?:kan)?|belajar)?\s*([A-Za-z0-9\s/]+?)(?:\s+(?:kalo|kalau|jika|bila)\s+belum\s+selesai|\s+selama|\s+jam|\s+pukul|$)/i
  );
  if (continueMatch) {
    let subject = continueMatch[1].trim();
    if (subject.toLowerCase() === "design" || subject.toLowerCase() === "desain") {
      subject = "Desain";
    } else {
      subject = toTitleCase(subject);
    }
    return `Melanjutkan ${subject}`;
  }
  let text = raw;
  text = text.replace(
    /^(?:tolong\s+)?(?:jadwalkan|masukkan|buatkan|bikin)?\s*(?:jadwal\s+)?(?:aku\s+|saya\s+|kami\s+)?(?:mau\s+|ingin\s+|pengen\s+|rencananya\s+)?(?:akan\s+ada\s+|ada\s+)?/i,
    ""
  );
  text = text.replace(
    /\b(?:hari\s+)?(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad)(?:\s+(?:dan|sampai|hingga|-)\s+(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|ahad))*\b/gi,
    ""
  );
  text = text.replace(/\b(?:besok\s+lusa|besok|lusa|kemarin|minggu\s+depan|hari\s+ini|nanti)\b/gi, "");
  text = text.replace(
    /(?:dari\s+)?(?:jam|pukul)?\s*\d{1,2}(?:[:.]\d{2})?\s*(?:pagi|siang|sore|malam)?\s*(?:sampai|hingga|s\/d|-|–)\s*(?:jam|pukul)?\s*\d{1,2}(?:[:.]\d{2})?\s*(?:pagi|siang|sore|malam)?/gi,
    ""
  );
  text = text.replace(/(?:pada\s+)?(?:jam|pukul)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:pagi|siang|sore|malam)?/gi, "");
  text = text.replace(/\b(?:malam\s+ini|pagi\s+ini|siang\s+ini|sore\s+ini)\b/gi, "");
  text = text.replace(/\b(?:malam|pagi|siang|sore)\b/gi, "");
  text = text.replace(
    /\b(?:selama\s+)?(?:\d+|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|setengah)\s*(?:setengah)?\s*(?:jam|menit|mnt)\b/gi,
    ""
  );
  text = text.replace(/\b(?:deadline[-a-zA-Z0-9]*|tenggat\s+waktu|paling\s+lambat)\s*(?:hari\s+\w+|\w+)?\b/gi, "");
  text = text.replace(/\b(?:kalo|kalau|jika|bila)\s+belum\s+selesai\b/gi, "");
  text = text.replace(/\b(?:akan\s+ada|ada|mau|selama)\b/gi, "");
  text = text.replace(/[,;:.–—-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length < 2) {
    return "Kegiatan Terjadwal";
  }
  return toTitleCase(text);
}
function getNextValidDateForDayOfWeek(targetDayOfWeek, referenceDate = /* @__PURE__ */ new Date(), timezone = "Asia/Jakarta", options) {
  const tz = parseTimezoneString(timezone);
  const baseParts = getPartsInTimezone(referenceDate, tz);
  const currentDayOfWeek = baseParts.dayOfWeek;
  let dayOffset = (targetDayOfWeek - currentDayOfWeek + 7) % 7;
  if (dayOffset === 0) {
    if (options?.forceNextWeek) {
      dayOffset = 7;
    } else if (options?.targetHour !== void 0) {
      const currentMinutes = baseParts.hour * 60 + baseParts.minute;
      const targetMinutes = options.targetHour * 60 + (options.targetMinute || 0);
      if (targetMinutes <= currentMinutes) {
        dayOffset = 7;
      }
    }
  }
  if (options?.weekOffset && options.weekOffset > 0) {
    dayOffset += options.weekOffset * 7;
  }
  const targetDateObj = addDaysInTimezone(referenceDate, dayOffset, tz);
  const targetParts = getPartsInTimezone(targetDateObj, tz);
  const dateStr = `${targetParts.year}-${String(targetParts.month).padStart(2, "0")}-${String(targetParts.day).padStart(2, "0")}`;
  const iso = createIsoInTimezone(
    targetParts.year,
    targetParts.month,
    targetParts.day,
    options?.targetHour ?? 0,
    options?.targetMinute ?? 0,
    0,
    tz
  );
  return {
    date: new Date(iso),
    dateStr,
    dayOffset,
    year: targetParts.year,
    month: targetParts.month,
    day: targetParts.day
  };
}
function parseIndonesianDayNames(prompt) {
  const p = prompt.toLowerCase();
  const days = [];
  const isRecurring = /\b(setiap|tiap|rutin|berulang|mingguan|per minggu|tiap-tiap|selalu)\b/i.test(prompt);
  const weekdayRegex = /\b(senin|selasa|rabu|kamis|jumat|jum'at|sabtu|ahad)\b/gi;
  let match;
  while ((match = weekdayRegex.exec(p)) !== null) {
    const word = match[1].toLowerCase();
    const entry = INDONESIAN_WEEKDAYS.find((w) => w.name === word);
    if (entry && !days.some((d) => d.dayIndex === entry.dayIndex)) {
      days.push({
        dayIndex: entry.dayIndex,
        dayName: DAY_NAMES_ID[entry.dayIndex],
        rawKeyword: word
      });
    }
  }
  const sundayRegex = /\b(?:hari\s+minggu|minggu\s+(?:pagi|siang|sore|malam|jam|pukul|\d)|(?:dan|sampai|hingga|-)\s+minggu)\b|\bminggu\b(?!\s+depan)/gi;
  if (sundayRegex.test(p)) {
    if (!days.some((d) => d.dayIndex === 0)) {
      days.push({
        dayIndex: 0,
        dayName: "Minggu",
        rawKeyword: "minggu"
      });
    }
  }
  return { days, isRecurring };
}
function parseIndonesianTemporalRules(ctx) {
  const prompt = ctx.userPrompt.trim().toLowerCase();
  const tz = parseTimezoneString(ctx.userTimezone || "Asia/Jakarta");
  const baseDate = ctx.currentDateTime ? new Date(ctx.currentDateTime) : /* @__PURE__ */ new Date();
  const baseParts = getPartsInTimezone(baseDate, tz);
  const { days: detectedWeekdays, isRecurring: promptIsRecurring } = parseIndonesianDayNames(prompt);
  let hasExplicitDayTarget = false;
  let dayOffset = 0;
  if (detectedWeekdays.length > 0) {
    hasExplicitDayTarget = true;
    const firstDay = detectedWeekdays[0].dayIndex;
    const nextDate = getNextValidDateForDayOfWeek(firstDay, baseDate, tz, {
      forceNextWeek: prompt.includes("depan")
    });
    dayOffset = nextDate.dayOffset;
  } else if (prompt.includes("besok lusa")) {
    dayOffset = 2;
    hasExplicitDayTarget = true;
  } else if (prompt.includes("lusa")) {
    dayOffset = 2;
    hasExplicitDayTarget = true;
  } else if (prompt.includes("besok")) {
    dayOffset = 1;
    hasExplicitDayTarget = true;
  } else if (prompt.includes("3 hari lagi")) {
    dayOffset = 3;
    hasExplicitDayTarget = true;
  } else if (prompt.includes("minggu depan")) {
    dayOffset = 7;
    hasExplicitDayTarget = true;
  } else if (prompt.includes("hari ini") || prompt.includes("malam ini") || prompt.includes("pagi ini") || prompt.includes("siang ini") || prompt.includes("sore ini")) {
    dayOffset = 0;
    hasExplicitDayTarget = true;
  }
  const targetDateObj = addDaysInTimezone(baseDate, dayOffset, tz);
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
  const wordToNum = {
    se: 1,
    satu: 1,
    dua: 2,
    tiga: 3,
    empat: 4,
    lima: 5,
    enam: 6,
    tujuh: 7,
    delapan: 8
  };
  const durMatch = prompt.match(/(\d+)\s*(menit|mnt|jam)/i);
  const wordDurMatch = prompt.match(/(?:selama\s+)?(se|satu|dua|tiga|empat|lima|enam|tujuh|delapan)\s*jam/i);
  const wordMinMatch = prompt.match(/(?:selama\s+)?(tiga puluh|empat puluh lima)\s*(?:menit|mnt)/i);
  if (durMatch) {
    const val = parseInt(durMatch[1], 10);
    const unit = durMatch[2].toLowerCase();
    if (unit === "jam") {
      duration = val * 60;
    } else {
      duration = val;
    }
  } else if (wordDurMatch) {
    const word = wordDurMatch[1].toLowerCase();
    const multiplier = wordToNum[word] || 1;
    duration = multiplier * 60;
  } else if (wordMinMatch) {
    if (wordMinMatch[1].includes("tiga puluh")) duration = 30;
    else if (wordMinMatch[1].includes("empat puluh lima")) duration = 45;
  } else if (prompt.includes("sejam") || prompt.includes("1 jam")) {
    duration = 60;
  } else if (prompt.includes("setengah jam")) {
    duration = 30;
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
  let targetOccurrences = void 0;
  let targetDays = detectedWeekdays.length > 0 ? detectedWeekdays.map((dw) => dw.dayIndex) : void 0;
  if (isExactFixedEvent && fixedStartHour !== null) {
    timeConstraintType = "fixed_event";
    if (detectedWeekdays.length > 0) {
      targetOccurrences = detectedWeekdays.map((dw) => {
        const nextDate = getNextValidDateForDayOfWeek(dw.dayIndex, baseDate, tz, {
          targetHour: fixedStartHour,
          targetMinute: fixedStartMin,
          forceNextWeek: prompt.includes("depan"),
          weekOffset: prompt.includes("minggu depan") ? 1 : 0
        });
        const occStartIso = createIsoInTimezone(
          nextDate.year,
          nextDate.month,
          nextDate.day,
          fixedStartHour,
          fixedStartMin,
          0,
          tz
        );
        const occStartDate = new Date(occStartIso);
        const occEndDate = new Date(occStartDate.getTime() + duration * 6e4);
        return {
          dayName: dw.dayName,
          dayOfWeek: dw.dayIndex,
          requestedStartAt: occStartIso,
          requestedEndAt: occEndDate.toISOString(),
          label: `${dw.dayName} (${String(fixedStartHour).padStart(2, "0")}:${String(fixedStartMin).padStart(2, "0")})`
        };
      });
      requestedStartAt = targetOccurrences[0].requestedStartAt;
      requestedEndAt = targetOccurrences[0].requestedEndAt;
    } else {
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
    }
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
  const title = extractCleanActivityTitle(ctx.userPrompt);
  let reasoning = "";
  if (timeConstraintType === "fixed_event") {
    if (targetOccurrences && targetOccurrences.length > 1) {
      reasoning = `AI mendeteksi ${targetOccurrences.length} komitmen waktu tetap terpisah (${targetOccurrences.map((o) => o.dayName).join(" dan ")}) pukul ${fixedStartHour ? String(fixedStartHour).padStart(2, "0") : "00"}:${String(fixedStartMin).padStart(2, "0")} - ${fixedEndHour ? String(fixedEndHour).padStart(2, "0") : "00"}:${String(fixedEndMin).padStart(2, "0")} sehingga dijadwalkan per hari tanpa digeser.`;
    } else {
      reasoning = `AI mendeteksi komitmen waktu tetap (${fixedStartHour ? String(fixedStartHour).padStart(2, "0") : "00"}:${String(fixedStartMin).padStart(2, "0")} - ${fixedEndHour ? String(fixedEndHour).padStart(2, "0") : "00"}:${String(fixedEndMin).padStart(2, "0")}) sehingga dijaga tanpa digeser.`;
    }
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
    targetDays,
    targetOccurrences,
    isRecurring: promptIsRecurring || detectedWeekdays.length > 1,
    recurrenceRule: promptIsRecurring || detectedWeekdays.length > 1 ? "WEEKLY_ON_DAYS" : void 0,
    hasExplicitDayTarget,
    isDayAmbiguous: isCommitmentKeyword && !hasExplicitDayTarget,
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
5. Sediakan 'reasoning' singkat dalam Bahasa Indonesia yang transparan.
6. JADWAL MULTI-HARI & PERULANGAN:
   - Jika pengguna menyebutkan beberapa hari (contoh: 'kelas pada Senin dan Selasa malam', 'Senin dan Rabu jam 19.00 - 21.00'), JANGAN PERNAH mengubahnya menjadi satu tugas berdurasi panjang 24 jam lebih!
   - Pisahkan menjadi daftar kejadian terpisah di 'targetOccurrences' dengan waktu mulai dan selesai per masing-masing hari.
7. PEMBUATAN JUDUL TUGAS (title):
   - Buat judul ringkas dan fokus pada inti kegiatan/subjek (contoh: 'UTS Web Programming', 'Melanjutkan Desain', 'Persiapan UTS Design', 'Rapat Koordinasi Tim').
   - JANGAN MENYALIN mentah-mentah seluruh prompt pengguna sebagai judul!`;
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
                    estimatedDurationMinutes: { type: Type.INTEGER, description: "Estimasi durasi dalam menit per sesi" },
                    deadlineDaysFromNow: { type: Type.INTEGER, description: "Tenggat waktu dalam jumlah hari dari sekarang" },
                    deadlineAt: { type: Type.STRING, description: "ISO string tenggat waktu absolut" },
                    priority: { type: Type.STRING, description: "Prioritas: LOW, MEDIUM, HIGH, atau URGENT" },
                    allowSplit: { type: Type.BOOLEAN, description: "Boleh dipecah beberapa sesi" },
                    minimumSessionMinutes: { type: Type.INTEGER, description: "Durasi minimal per sesi jika dipecah" },
                    targetOccurrences: {
                      type: Type.ARRAY,
                      description: "Daftar kejadian jika pengguna menyebutkan beberapa hari (contoh: Senin dan Selasa malam)",
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          dayName: { type: Type.STRING, description: "Nama hari (contoh: Senin, Selasa)" },
                          requestedStartAt: { type: Type.STRING, description: "ISO string waktu mulai untuk kejadian hari ini" },
                          requestedEndAt: { type: Type.STRING, description: "ISO string waktu selesai untuk kejadian hari ini" }
                        },
                        required: ["dayName", "requestedStartAt", "requestedEndAt"]
                      }
                    },
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
      if (baselinePlan.targetOccurrences && baselinePlan.targetOccurrences.length > 1) {
        sanitizedPlan.timeConstraintType = "fixed_event";
        sanitizedPlan.targetOccurrences = baselinePlan.targetOccurrences;
        sanitizedPlan.targetDays = baselinePlan.targetDays;
        sanitizedPlan.requestedStartAt = baselinePlan.targetOccurrences[0].requestedStartAt;
        sanitizedPlan.requestedEndAt = baselinePlan.targetOccurrences[0].requestedEndAt;
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes;
        sanitizedPlan.allowSplit = false;
      } else if (rawPlan.targetOccurrences && Array.isArray(rawPlan.targetOccurrences) && rawPlan.targetOccurrences.length > 1) {
        sanitizedPlan.timeConstraintType = "fixed_event";
        sanitizedPlan.targetOccurrences = rawPlan.targetOccurrences;
        sanitizedPlan.requestedStartAt = rawPlan.targetOccurrences[0].requestedStartAt;
        sanitizedPlan.requestedEndAt = rawPlan.targetOccurrences[0].requestedEndAt;
        sanitizedPlan.estimatedDurationMinutes = baselinePlan.estimatedDurationMinutes || rawPlan.estimatedDurationMinutes;
        sanitizedPlan.allowSplit = false;
      } else if (baselinePlan.timeConstraintType === "fixed_event") {
        sanitizedPlan.timeConstraintType = "fixed_event";
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
          sanitizedPlan.targetDays = baselinePlan.targetDays;
        }
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
      sanitizedPlan.title = extractCleanActivityTitle(trimmedPrompt, rawPlan.title || baselinePlan.title);
      if (!sanitizedPlan.description || sanitizedPlan.description.trim() === "") {
        sanitizedPlan.description = `Catatan asli: "${trimmedPrompt}"`;
      } else if (!sanitizedPlan.description.includes(trimmedPrompt)) {
        sanitizedPlan.description = `${sanitizedPlan.description}
Catatan asli: "${trimmedPrompt}"`;
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
