import {
  normalizeTimezone,
  getZonedDateTimeParts,
  createIsoFromLocalZoned,
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

const MONTH_NAMES_INDONESIAN: Record<string, number> = {
  jan: 1,
  januari: 1,
  feb: 2,
  februari: 2,
  mar: 3,
  maret: 3,
  apr: 4,
  april: 4,
  mei: 5,
  jun: 6,
  juni: 6,
  jul: 7,
  juli: 7,
  agu: 8,
  agus: 8,
  agustus: 8,
  ags: 8,
  agt: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  nov: 11,
  november: 11,
  des: 12,
  desember: 12,
};

/**
 * Intelligent deterministic Indonesian temporal rule parser.
 * Works both as high-precision standalone parser and as a post-validator for LLM outputs.
 * Completely timezone-safe across host architectures.
 */
export function parseIndonesianTemporalRules(
  ctxOrPrompt: ParseContext | string,
  userTimezone?: string,
  workHours?: { workStartHour: number; workEndHour: number }
) {
  const ctx: ParseContext =
    typeof ctxOrPrompt === 'string'
      ? {
          userPrompt: ctxOrPrompt,
          userTimezone: userTimezone || 'Asia/Jakarta',
          workHours: workHours || { workStartHour: 8, workEndHour: 18 },
        }
      : ctxOrPrompt;

  const prompt = (ctx.userPrompt || '').trim().toLowerCase();
  const tz = normalizeTimezone(ctx.userTimezone || 'Asia/Jakarta');

  // Base reference date parsed into user's timezone components
  const baseDate = ctx.currentDateTime ? new Date(ctx.currentDateTime) : new Date();
  const baseParts = getZonedDateTimeParts(baseDate, tz);

  // 1. Detect explicit date in prompt (e.g. "Kamis 22 Okt", "22 Oktober 2026", "22/10/2026")
  let targetYear = baseParts.year;
  let targetMonth = baseParts.month;
  let targetDay = baseParts.day;
  let explicitDateFound = false;

  // Regex pattern for "22 Okt", "22 Oktober", "22 Oktober 2026"
  const explicitMonthMatch = prompt.match(
    /\b(\d{1,2})\s+(jan(?:uari)?|feb(?:ruari)?|mar(?:et)?|apr(?:il)?|mei|jun(?:i)?|jul(?:i)?|agu(?:stus)?|ags|agt|sep(?:tember)?|okt(?:ober)?|nov(?:ember)?|des(?:ember)?)(?:\s+(\d{4}))?\b/i
  );

  if (explicitMonthMatch) {
    const dayVal = parseInt(explicitMonthMatch[1], 10);
    const monthStr = explicitMonthMatch[2].toLowerCase();
    const yearVal = explicitMonthMatch[3] ? parseInt(explicitMonthMatch[3], 10) : baseParts.year;
    const monthNum = MONTH_NAMES_INDONESIAN[monthStr];

    if (monthNum && dayVal >= 1 && dayVal <= 31) {
      targetDay = dayVal;
      targetMonth = monthNum;
      targetYear = yearVal;
      explicitDateFound = true;
    }
  }

  // Regex for numeric date: DD/MM/YYYY or DD-MM-YYYY
  if (!explicitDateFound) {
    const numDateMatch = prompt.match(/\b(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?\b/);
    if (numDateMatch) {
      const dayVal = parseInt(numDateMatch[1], 10);
      const monthVal = parseInt(numDateMatch[2], 10);
      const yearVal = numDateMatch[3] ? parseInt(numDateMatch[3], 10) : baseParts.year;
      if (dayVal >= 1 && dayVal <= 31 && monthVal >= 1 && monthVal <= 12) {
        targetDay = dayVal;
        targetMonth = monthVal;
        targetYear = yearVal;
        explicitDateFound = true;
      }
    }
  }

  // Relative day offset if no explicit date was found
  let dayOffset = 0;
  if (!explicitDateFound) {
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

    if (dayOffset > 0) {
      // Calculate new target day using UTC constructor to avoid local machine timezone distortion
      const refUtc = new Date(Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day + dayOffset));
      targetYear = refUtc.getUTCFullYear();
      targetMonth = refUtc.getUTCMonth() + 1;
      targetDay = refUtc.getUTCDate();
    }
  }

  // Check if it's explicitly a fixed commitment/event:
  // e.g. "kelas", "kuliah", "webinar", "rapat", "meeting", "janji", "jadwal", or has range "dari jam X sampai Y"
  const isCommitmentKeyword = /\b(kelas|kuliah|webinar|rapat|meeting|janji|jadwal|workshop|seminar|konsultasi|kursus)\b/i.test(prompt);

  // 2. Detect start-end range: e.g. "jam 7 malam sampai jam 10 malam", "jam 7 sampai 10 malam", "19.00 - 22.00", "pukul 19:00-22:00"
  let fixedStartHour: number | null = null;
  let fixedStartMin: number = 0;
  let fixedEndHour: number | null = null;
  let fixedEndMin: number = 0;

  // Pattern: "19.00 - 22.00" or "19:00 - 22:00" or "07.00 - 09.00"
  const colonRangeMatch = prompt.match(/(?:pukul|jam)?\s*(\d{1,2})[:.](\d{2})\s*(?:-|–|sampai|s\/d|hingga)\s*(?:pukul|jam)?\s*(\d{1,2})[:.](\d{2})/i);
  if (colonRangeMatch) {
    fixedStartHour = parseInt(colonRangeMatch[1], 10);
    fixedStartMin = parseInt(colonRangeMatch[2], 10);
    fixedEndHour = parseInt(colonRangeMatch[3], 10);
    fixedEndMin = parseInt(colonRangeMatch[4], 10);
  }

  // Pattern: "jam 7 malam sampai (jam) 10 malam", "jam 7 sampai 10 malam", "jam 19 sampai 22"
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
    }
  }

  // 3. Detect single specific time e.g. "malam ini jam 9", "jam 9 malam", "pukul 21.00", "jam 20.30"
  if (fixedStartHour === null) {
    const singleTimeMatch = prompt.match(/(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?/i);
    if (singleTimeMatch) {
      let h = parseInt(singleTimeMatch[1], 10);
      const m = singleTimeMatch[2] ? parseInt(singleTimeMatch[2], 10) : 0;
      const period = singleTimeMatch[3];

      const isNight = period === 'malam' || (prompt.includes('malam') && !prompt.includes('siang'));
      const isAfternoon = period === 'sore' || prompt.includes('sore');
      const isNoon = period === 'siang' || prompt.includes('siang');

      if (isNight) {
        if (h === 12) {
          h = 0; // 12 malam = midnight (00:00)
        } else if (h < 12) {
          h += 12;
        }
      } else if (isAfternoon && h <= 6) {
        h += 12;
      } else if (isNoon && h >= 1 && h <= 3) {
        h += 12;
      }

      fixedStartHour = h;
      fixedStartMin = m;
    } else {
      if (prompt.includes('sembilan malam') || prompt.includes('9 malam')) {
        fixedStartHour = 21;
        fixedStartMin = 0;
      } else if (prompt.includes('tujuh malam') || prompt.includes('7 malam')) {
        fixedStartHour = 19;
        fixedStartMin = 0;
      } else if (prompt.includes('delapan malam') || prompt.includes('8 malam')) {
        fixedStartHour = 20;
        fixedStartMin = 0;
      } else if (prompt.includes('sepuluh malam') || prompt.includes('10 malam')) {
        fixedStartHour = 22;
        fixedStartMin = 0;
      } else if (prompt.includes('dua belas malam') || prompt.includes('12 malam')) {
        fixedStartHour = 0;
        fixedStartMin = 0;
      } else if (prompt.includes('dua belas siang') || prompt.includes('12 siang')) {
        fixedStartHour = 12;
        fixedStartMin = 0;
      }
    }
  }

  // Determine Duration
  let duration = 60;
  let explicitDurationFound = false;
  const durMatch = prompt.match(/(\d+)\s*(?:menit|mnt|jam)/i);
  if (durMatch) {
    explicitDurationFound = true;
    const val = parseInt(durMatch[1], 10);
    if (prompt.includes(`${val} jam`)) {
      duration = val * 60;
    } else {
      duration = val;
    }
  } else if (fixedStartHour !== null && fixedEndHour !== null) {
    const startTotal = fixedStartHour * 60 + fixedStartMin;
    const endTotal = fixedEndHour * 60 + fixedEndMin;
    if (endTotal > startTotal) {
      duration = endTotal - startTotal;
    } else {
      // Cross-midnight: wraps around 24 hours (e.g. 23:00 to 01:30 = 150 minutes)
      duration = (24 * 60 - startTotal) + endTotal;
    }
  }

  // If fixedStartHour is known but fixedEndHour is not, calculate fixedEndHour from duration
  if (fixedStartHour !== null && fixedEndHour === null) {
    const startTotal = fixedStartHour * 60 + fixedStartMin;
    const endTotal = startTotal + duration;
    fixedEndHour = Math.floor(endTotal / 60) % 24;
    fixedEndMin = endTotal % 60;
  }

  // Helper to determine time of day period & natural Indonesian label
  const getPeriodMeta = (h: number): { period: 'MORNING' | 'AFTERNOON' | 'EVENING'; label: string } => {
    if (h >= 18) return { period: 'EVENING', label: 'Malam' };
    if (h >= 15) return { period: 'AFTERNOON', label: 'Sore' };
    if (h >= 11) return { period: 'AFTERNOON', label: 'Siang' };
    if (h >= 4) return { period: 'MORNING', label: 'Pagi' };
    return { period: 'EVENING', label: 'Malam' };
  };

  let timeConstraintType: 'fixed_event' | 'preferred_window' | 'deadline_only' = 'deadline_only';
  let requestedStartAt: string | undefined = undefined;
  let requestedEndAt: string | undefined = undefined;
  let preferredWindow: { startHour: number; startMinute?: number; endHour: number; endMinute?: number; label?: string } | undefined = undefined;
  let preferredTimeOfDay: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY' = 'ANY';

  // Explicit start phrases like "dari jam 12", "mulai jam 12", "pukul 12"
  const hasExplicitStartPhrase = /\b(dari\s+(?:jam|pukul)|mulai\s+(?:jam|pukul)?)\s*\d+/i.test(prompt);

  if (fixedStartHour !== null && (isCommitmentKeyword || colonRangeMatch || hasExplicitStartPhrase || prompt.includes('sampai') || prompt.includes('–') || prompt.includes('-'))) {
    timeConstraintType = 'fixed_event';

    requestedStartAt = createIsoFromLocalZoned(
      targetYear,
      targetMonth,
      targetDay,
      fixedStartHour,
      fixedStartMin,
      0,
      tz
    );

    const actualEndH = fixedEndHour !== null ? fixedEndHour : (fixedStartHour + 1) % 24;
    const isCrossMidnight = actualEndH < fixedStartHour || (actualEndH === fixedStartHour && fixedEndMin < fixedStartMin);

    let endYear = targetYear;
    let endMonth = targetMonth;
    let endDay = targetDay;

    if (isCrossMidnight) {
      // Advance to next day safely in calendar date
      const nextDayUtc = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + 1));
      endYear = nextDayUtc.getUTCFullYear();
      endMonth = nextDayUtc.getUTCMonth() + 1;
      endDay = nextDayUtc.getUTCDate();
    }

    requestedEndAt = createIsoFromLocalZoned(
      endYear,
      endMonth,
      endDay,
      actualEndH,
      fixedEndMin,
      0,
      tz
    );

    const diffMs = new Date(requestedEndAt).getTime() - new Date(requestedStartAt).getTime();
    duration = Math.max(15, Math.round(diffMs / 60000));
    const meta = getPeriodMeta(fixedStartHour);
    preferredTimeOfDay = meta.period;
  } else if (fixedStartHour !== null) {
    // Single time specified like "malam ini jam 9" or "jam 21.00"
    const meta = getPeriodMeta(fixedStartHour);
    preferredTimeOfDay = meta.period;

    if (isCommitmentKeyword || explicitDurationFound) {
      // If duration is explicitly specified along with the time, treat as fixed event
      timeConstraintType = 'fixed_event';
      requestedStartAt = createIsoFromLocalZoned(
        targetYear,
        targetMonth,
        targetDay,
        fixedStartHour,
        fixedStartMin,
        0,
        tz
      );

      const endTotal = fixedStartHour * 60 + fixedStartMin + duration;
      const calcEndHour = Math.floor(endTotal / 60) % 24;
      const calcEndMin = endTotal % 60;
      const isCross = calcEndHour < fixedStartHour || (calcEndHour === fixedStartHour && calcEndMin < fixedStartMin);

      let endYear = targetYear;
      let endMonth = targetMonth;
      let endDay = targetDay;
      if (isCross) {
        const nextDayUtc = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay + 1));
        endYear = nextDayUtc.getUTCFullYear();
        endMonth = nextDayUtc.getUTCMonth() + 1;
        endDay = nextDayUtc.getUTCDate();
      }

      requestedEndAt = createIsoFromLocalZoned(
        endYear,
        endMonth,
        endDay,
        calcEndHour,
        calcEndMin,
        0,
        tz
      );
    } else {
      timeConstraintType = 'preferred_window';
      const windowEndHour = Math.min(23, fixedStartHour + Math.ceil(duration / 60) + 1);
      preferredWindow = {
        startHour: fixedStartHour,
        startMinute: fixedStartMin,
        endHour: windowEndHour,
        endMinute: 0,
        label: `${meta.label} (${String(fixedStartHour).padStart(2, '0')}:${String(fixedStartMin).padStart(2, '0')} - ${String(windowEndHour).padStart(2, '0')}:00)`,
      };
    }
  } else if (prompt.includes('malam')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 19, startMinute: 0, endHour: 23, endMinute: 0, label: 'Malam (19:00 - 23:00)' };
    preferredTimeOfDay = 'EVENING';
  } else if (prompt.includes('sore')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 15, startMinute: 0, endHour: 18, endMinute: 0, label: 'Sore (15:00 - 18:00)' };
    preferredTimeOfDay = 'AFTERNOON';
  } else if (prompt.includes('siang')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 13, startMinute: 0, endHour: 15, endMinute: 0, label: 'Siang (13:00 - 15:00)' };
    preferredTimeOfDay = 'AFTERNOON';
  } else if (prompt.includes('pagi')) {
    timeConstraintType = 'preferred_window';
    preferredWindow = { startHour: 8, startMinute: 0, endHour: 12, endMinute: 0, label: 'Pagi (08:00 - 12:00)' };
    preferredTimeOfDay = 'MORNING';
  }

  // Deadline calculation in user's timezone
  let deadlineAt: string;
  if (timeConstraintType === 'fixed_event' && requestedEndAt) {
    deadlineAt = requestedEndAt;
  } else {
    const deadlineHour = preferredTimeOfDay === 'EVENING' ? 23 : 18;
    deadlineAt = createIsoFromLocalZoned(
      targetYear,
      targetMonth,
      targetDay,
      deadlineHour,
      0,
      0,
      tz
    );
  }

  // Priority
  let priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' = 'MEDIUM';
  if (prompt.includes('urgent') || prompt.includes('segera') || prompt.includes('penting sekali')) {
    priority = 'URGENT';
  } else if (prompt.includes('tinggi') || prompt.includes('prioritas') || isCommitmentKeyword) {
    priority = 'HIGH';
  } else if (prompt.includes('santai') || prompt.includes('low')) {
    priority = 'LOW';
  }

  // Splitting: fixed events CANNOT be split!
  const allowSplit = timeConstraintType !== 'fixed_event' && (prompt.includes('bagi') || prompt.includes('sesi') || prompt.includes('cicil'));
  const minSession = 30;

  // Title formatting
  let title = ctx.userPrompt.trim();
  if (title.length > 50) {
    title = title.slice(0, 47) + '...';
  }

  // Reasoning in formal Indonesian
  let reasoning = '';
  if (timeConstraintType === 'fixed_event') {
    reasoning = `AI mendeteksi komitmen waktu tetap (${fixedStartHour ? String(fixedStartHour).padStart(2, '0') : '00'}:${String(fixedStartMin).padStart(2, '0')} - ${fixedEndHour ? String(fixedEndHour).padStart(2, '0') : '00'}:${String(fixedEndMin).padStart(2, '0')}) sehingga dijaga tanpa digeser.`;
  } else if (preferredWindow) {
    reasoning = `AI menetapkan jendela preferensi ${preferredWindow.label} dengan durasi ${duration} menit agar sesuai dengan waktu fokus pilihan Anda.`;
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
    deadlineAt,
    deadlineDaysFromNow: Math.max(1, dayOffset),
    timezone: tz,
    priority,
    allowSplit,
    minimumSessionMinutes: minSession,
    reasoning,
  };
}
