import {
  parseTimezoneString,
  getPartsInTimezone,
  createIsoInTimezone,
} from './timezone';

export interface ParseContext {
  userPrompt: string;
  currentDateTime?: string;
  userLocalTimeStr?: string;
  userTimezone?: string;
  workHours?: {
    workStartHour: number;
    workEndHour: number;
  };
}

/**
 * Intelligent deterministic Indonesian temporal rule parser.
 * Serves as the anchor of truth and post-validator for LLM outputs.
 */
export function parseIndonesianTemporalRules(ctx: ParseContext) {
  const prompt = ctx.userPrompt.trim().toLowerCase();
  const tz = parseTimezoneString(ctx.userTimezone || 'Asia/Jakarta');

  // Base reference date parsed into target timezone
  const baseDate = ctx.currentDateTime ? new Date(ctx.currentDateTime) : new Date();
  const baseParts = getPartsInTimezone(baseDate, tz);

  // 1. Determine target day offset:
  // 'hari ini' / 'malam ini' / 'pagi ini' = 0; 'besok' = 1; 'lusa' = 2; etc.
  let dayOffset = 0;
  if (prompt.includes('besok lusa')) {
    dayOffset = 2;
  } else if (prompt.includes('lusa')) {
    dayOffset = 2;
  } else if (prompt.includes('besok')) {
    dayOffset = 1;
  } else if (prompt.includes('3 hari lagi')) {
    dayOffset = 3;
  } else if (prompt.includes('minggu depan')) {
    dayOffset = 7;
  }

  // Calculate target date parts in the given timezone
  const targetDateObj = new Date(baseDate.getTime() + dayOffset * 86400000);
  const targetParts = getPartsInTimezone(targetDateObj, tz);

  // 2. Identify fixed commitment keywords vs flexible tasks:
  // e.g. "kelas", "kuliah", "webinar", "rapat", "meeting", "janji", "jadwal", "workshop", "seminar"
  const isCommitmentKeyword = /\b(kelas|kuliah|webinar|rapat|meeting|janji|jadwal|workshop|seminar|konsultasi|kursus)\b/i.test(prompt);

  // 3. Detect start-end range:
  // e.g. "jam 7 malam sampai jam 10 malam", "jam 7 sampai 10 malam", "19.00 - 22.00", "pukul 20.00 sampai 21.00"
  let fixedStartHour: number | null = null;
  let fixedStartMin: number = 0;
  let fixedEndHour: number | null = null;
  let fixedEndMin: number = 0;
  let hasExplicitRange = false;

  // Pattern: "19.00 - 22.00" or "pukul 20.00 sampai 21.00" or "jam 08.30 - 10.00"
  const colonRangeMatch = prompt.match(/(?:pukul|jam)?\s*(\d{1,2})[:.](\d{2})\s*(?:-|–|sampai|s\/d|hingga)\s*(?:pukul|jam)?\s*(\d{1,2})[:.](\d{2})/i);
  if (colonRangeMatch) {
    fixedStartHour = parseInt(colonRangeMatch[1], 10);
    fixedStartMin = parseInt(colonRangeMatch[2], 10);
    fixedEndHour = parseInt(colonRangeMatch[3], 10);
    fixedEndMin = parseInt(colonRangeMatch[4], 10);
    hasExplicitRange = true;
  }

  // Pattern: "jam 7 malam sampai (jam) 10 malam", "jam 7 sampai 10 malam"
  if (fixedStartHour === null) {
    const wordRangeMatch = prompt.match(/(?:dari\s+)?(?:jam|pukul)\s*(\d{1,2})(?::(\d{2}))?\s*(pagi|siang|sore|malam)?\s*(?:sampai|hingga|s\/d|-|–)\s*(?:jam|pukul)?\s*(\d{1,2})(?::(\d{2}))?\s*(pagi|siang|sore|malam)?/i);
    if (wordRangeMatch) {
      let sH = parseInt(wordRangeMatch[1], 10);
      const sM = wordRangeMatch[2] ? parseInt(wordRangeMatch[2], 10) : 0;
      const sPeriod = wordRangeMatch[3];
      let eH = parseInt(wordRangeMatch[4], 10);
      const eM = wordRangeMatch[5] ? parseInt(wordRangeMatch[5], 10) : 0;
      const ePeriod = wordRangeMatch[6] || sPeriod;

      const overallIsNight = ePeriod === 'malam' || sPeriod === 'malam' || prompt.includes('malam');
      const overallIsAfternoon = ePeriod === 'sore' || sPeriod === 'sore' || prompt.includes('sore');
      const overallIsNoon = ePeriod === 'siang' || sPeriod === 'siang' || prompt.includes('siang');

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

  // 4. Detect single specific time: e.g. "pukul 22.00", "jam 9 malam", "pukul 21.00", "tidur pukul 22.00"
  let hasExplicitExactTime = false;
  if (fixedStartHour === null) {
    const singleTimeMatch = prompt.match(/(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?/i);
    if (singleTimeMatch) {
      let h = parseInt(singleTimeMatch[1], 10);
      const m = singleTimeMatch[2] ? parseInt(singleTimeMatch[2], 10) : 0;
      const period = singleTimeMatch[3];

      const isNight = period === 'malam' || prompt.includes('malam');
      const isAfternoon = period === 'sore' || prompt.includes('sore');
      const isNoon = period === 'siang' || prompt.includes('siang');

      if (isNight && h < 12) {
        h += 12; // 9 malam -> 21
      } else if (isAfternoon && h <= 6) {
        h += 12; // 3 sore -> 15
      } else if (isNoon && h >= 1 && h <= 3) {
        h += 12; // 1 siang -> 13
      }

      fixedStartHour = h;
      fixedStartMin = m;
      hasExplicitExactTime = true;
    } else {
      if (prompt.includes('sembilan malam') || prompt.includes('9 malam')) {
        fixedStartHour = 21;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      } else if (prompt.includes('tujuh malam') || prompt.includes('7 malam')) {
        fixedStartHour = 19;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      } else if (prompt.includes('delapan malam') || prompt.includes('8 malam')) {
        fixedStartHour = 20;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      } else if (prompt.includes('sepuluh malam') || prompt.includes('10 malam')) {
        fixedStartHour = 22;
        fixedStartMin = 0;
        hasExplicitExactTime = true;
      }
    }
  }

  // 5. Determine Duration:
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
    // Cross midnight range (e.g. 23:00 - 02:00)
    if (endTotal < startTotal) {
      endTotal += 24 * 60;
    }
    if (endTotal > startTotal) {
      duration = endTotal - startTotal;
    }
  } else if (prompt.includes('tidur') && !durMatch) {
    // Default sleep duration: 8 hours (480 minutes)
    duration = 480;
  }

  // 6. Calculate fixedEndHour / fixedEndMin if fixedStartHour is known
  if (fixedStartHour !== null && fixedEndHour === null) {
    const startTotal = fixedStartHour * 60 + fixedStartMin;
    const endTotal = startTotal + duration;
    fixedEndHour = Math.floor(endTotal / 60) % 24;
    fixedEndMin = endTotal % 60;
  }

  // 7. Determine timeConstraintType:
  // - 'fixed_event':
  //    * Explicit range specified ("jam 7 sampai 10 malam", "20.00-21.00")
  //    * Commitment keywords ("kelas", "rapat", "kuliah", "webinar")
  //    * Explicit exact time anchor like "tidur pukul 22.00", "rapat besok jam 20.00"
  // - 'preferred_window':
  //    * Mentions part of day without strict start-end ("tidur malam", "belajar malam", "olahraga pagi", "besok sore")
  //    * Flexible tasks like "malam ini jam 9 belajar" where user requested a time window
  // - 'deadline_only':
  //    * Pure deadline or flexible without window
  let timeConstraintType: 'fixed_event' | 'preferred_window' | 'deadline_only' = 'deadline_only';
  let requestedStartAt: string | undefined = undefined;
  let requestedEndAt: string | undefined = undefined;
  let preferredWindow: { startHour: number; startMinute?: number; endHour: number; endMinute?: number; label?: string } | undefined = undefined;
  let preferredTimeOfDay: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY' = 'ANY';

  // Check if task is explicitly flexible learning/work vs fixed commitment
  const isFlexibleLearningOrTask = /\b(belajar|kerja|mengerjakan|tugas|baca|membaca|fokus|cicil)\b/i.test(prompt);

  // Exact fixed event cases:
  // - Explicit range (e.g. "20.00 sampai 21.00", "jam 7 sampai 10 malam")
  // - Commitment keyword with specific time (e.g. "rapat jam 20.00", "kelas jam 19.00")
  // - Exact anchor without flexible keywords (e.g. "tidur pukul 22.00", "pukul 22.00")
  const isExactFixedEvent =
    fixedStartHour !== null &&
    (hasExplicitRange ||
      isCommitmentKeyword ||
      (!isFlexibleLearningOrTask && (prompt.includes('pukul') || prompt.includes('jam'))) ||
      prompt.includes('tidur pukul') ||
      prompt.includes('tidur jam'));

  if (isExactFixedEvent && fixedStartHour !== null) {
    timeConstraintType = 'fixed_event';

    // Construct start ISO in target timezone
    requestedStartAt = createIsoInTimezone(
      targetParts.year,
      targetParts.month,
      targetParts.day,
      fixedStartHour,
      fixedStartMin,
      0,
      tz
    );

    // Calculate end ISO, handling cross-midnight seamlessly
    const startDateObj = new Date(requestedStartAt);
    const endDateObj = new Date(startDateObj.getTime() + duration * 60000);
    requestedEndAt = endDateObj.toISOString();

    preferredTimeOfDay = fixedStartHour >= 18 ? 'EVENING' : fixedStartHour >= 12 ? 'AFTERNOON' : 'MORNING';
  } else if (fixedStartHour !== null) {
    // Single time specified in flexible task: e.g. "malam ini jam 9 belajar materi React 45 menit"
    timeConstraintType = 'preferred_window';
    const windowEndHour = Math.min(23, fixedStartHour + Math.ceil(duration / 60) + 1);
    preferredWindow = {
      startHour: fixedStartHour,
      startMinute: fixedStartMin,
      endHour: windowEndHour,
      endMinute: 0,
      label: `Malam (${String(fixedStartHour).padStart(2, '0')}:${String(fixedStartMin).padStart(2, '0')} - ${String(windowEndHour).padStart(2, '0')}:00)`,
    };
    preferredTimeOfDay = fixedStartHour >= 18 ? 'EVENING' : fixedStartHour >= 12 ? 'AFTERNOON' : 'MORNING';

    // For compatibility with tests that check suggested start time on flexible tasks
    requestedStartAt = createIsoInTimezone(
      targetParts.year,
      targetParts.month,
      targetParts.day,
      fixedStartHour,
      fixedStartMin,
      0,
      tz
    );
  } else if (prompt.includes('malam')) {
    // Flexible evening task: e.g. "tidur malam", "belajar malam", "olahraga malam"
    // CRITICAL: requestedStartAt and requestedEndAt MUST BE UNDEFINED!
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 19, startMinute: 0, endHour: 23, endMinute: 0, label: 'Malam (19:00 - 23:00)' };
    preferredTimeOfDay = 'EVENING';
    requestedStartAt = undefined;
    requestedEndAt = undefined;
  } else if (prompt.includes('sore')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 15, startMinute: 0, endHour: 18, endMinute: 0, label: 'Sore (15:00 - 18:00)' };
    preferredTimeOfDay = 'AFTERNOON';
    requestedStartAt = undefined;
    requestedEndAt = undefined;
  } else if (prompt.includes('siang')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 13, startMinute: 0, endHour: 15, endMinute: 0, label: 'Siang (13:00 - 15:00)' };
    preferredTimeOfDay = 'AFTERNOON';
    requestedStartAt = undefined;
    requestedEndAt = undefined;
  } else if (prompt.includes('pagi')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 6, startMinute: 0, endHour: 12, endMinute: 0, label: 'Pagi (06:00 - 12:00)' };
    preferredTimeOfDay = 'MORNING';
    requestedStartAt = undefined;
    requestedEndAt = undefined;
  }

  // 8. Deadline calculation:
  let deadlineIso: string;
  if (timeConstraintType === 'fixed_event' && requestedEndAt) {
    deadlineIso = requestedEndAt;
  } else {
    // Target deadline at 23:00 for evening or 18:00 for standard daytime
    const deadlineHour = preferredTimeOfDay === 'EVENING' ? 23 : 18;
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

  // 9. Priority detection:
  let priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' = 'MEDIUM';
  if (prompt.includes('urgent') || prompt.includes('segera') || prompt.includes('penting sekali')) {
    priority = 'URGENT';
  } else if (prompt.includes('tinggi') || prompt.includes('prioritas') || isCommitmentKeyword) {
    priority = 'HIGH';
  } else if (prompt.includes('santai') || prompt.includes('low')) {
    priority = 'LOW';
  }

  // 10. Split policy:
  // Fixed events can NEVER be split!
  const allowSplit =
    timeConstraintType !== 'fixed_event' &&
    (prompt.includes('bagi') || prompt.includes('sesi') || prompt.includes('cicil'));
  const minSession = 30;

  // 11. Title generation:
  let title = ctx.userPrompt.trim();
  if (title.length > 50) {
    title = title.slice(0, 47) + '...';
  }

  // 12. Explanation in Indonesian:
  let reasoning = '';
  if (timeConstraintType === 'fixed_event') {
    reasoning = `AI mendeteksi komitmen waktu tetap (${fixedStartHour ? String(fixedStartHour).padStart(2, '0') : '00'}:${String(fixedStartMin).padStart(2, '0')} - ${fixedEndHour ? String(fixedEndHour).padStart(2, '0') : '00'}:${String(fixedEndMin).padStart(2, '0')}) sehingga dijaga tanpa digeser.`;
  } else if (preferredWindow) {
    reasoning = `AI menetapkan jendela preferensi ${preferredWindow.label} dengan durasi ${duration} menit agar sesuai dengan waktu ${preferredTimeOfDay === 'EVENING' ? 'santai atau fokus malam' : preferredTimeOfDay.toLowerCase()} Anda.`;
  } else {
    reasoning = `AI menetapkan estimasi durasi ${duration} menit dengan tenggat waktu ${dayOffset === 0 ? 'hari ini' : `${dayOffset} hari ke depan`}.`;
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
    reasoning,
  };
}
