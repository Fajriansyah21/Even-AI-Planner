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
 * Works both as high-precision standalone parser and as a post-validator for LLM outputs.
 */
export function parseIndonesianTemporalRules(ctx: ParseContext) {
  const prompt = ctx.userPrompt.trim().toLowerCase();
  const tz = ctx.userTimezone || 'Asia/Jakarta';
  
  // Base reference date
  const baseDate = ctx.currentDateTime ? new Date(ctx.currentDateTime) : new Date();
  
  // Determine target date offset: 'hari ini' / 'malam ini' = 0; 'besok' = 1; 'lusa' = 2; etc.
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

  // Calculate target date
  const targetDate = new Date(baseDate);
  targetDate.setDate(targetDate.getDate() + dayOffset);
  
  // Check if it's explicitly a fixed commitment/event:
  // e.g. "kelas", "kuliah", "webinar", "rapat", "meeting", "janji", "jadwal", or has range "dari jam X sampai Y"
  const isCommitmentKeyword = /\b(kelas|kuliah|webinar|rapat|meeting|janji|jadwal|workshop|seminar|konsultasi|kursus)\b/i.test(prompt);
  
  // 1. Detect start-end range: e.g. "jam 7 malam sampai jam 10 malam", "jam 7 sampai 10 malam", "19.00 - 22.00", "pukul 19:00-22:00"
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
      const ePeriod = wordRangeMatch[6] || sPeriod; // If second has 'malam', apply to first if appropriate
      
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

  // 2. Detect single specific time e.g. "malam ini jam 9", "jam 9 malam", "pukul 21.00", "jam 20.30"
  if (fixedStartHour === null) {
    // Pattern: "jam 9 malam", "jam sembilan malam", "pukul 21.00"
    const singleTimeMatch = prompt.match(/(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(pagi|siang|sore|malam)?/i);
    if (singleTimeMatch) {
      let h = parseInt(singleTimeMatch[1], 10);
      const m = singleTimeMatch[2] ? parseInt(singleTimeMatch[2], 10) : 0;
      const period = singleTimeMatch[3];
      
      const isNight = period === 'malam' || prompt.includes('malam');
      const isAfternoon = period === 'sore' || prompt.includes('sore');
      const isNoon = period === 'siang' || prompt.includes('siang');
      
      if (isNight && h < 12) {
        h += 12; // e.g. 9 malam -> 21
      } else if (isAfternoon && h <= 6) {
        h += 12; // e.g. 3 sore -> 15
      } else if (isNoon && h >= 1 && h <= 3) {
        h += 12; // e.g. 1 siang -> 13
      }
      
      fixedStartHour = h;
      fixedStartMin = m;
    } else {
      // Check word number e.g. "jam sembilan malam"
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
      }
    }
  }

  // Determine Duration
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
    const startTotal = fixedStartHour * 60 + fixedStartMin;
    const endTotal = fixedEndHour * 60 + fixedEndMin;
    if (endTotal > startTotal) {
      duration = endTotal - startTotal;
    }
  }

  // If fixedStartHour is known but fixedEndHour is not, calculate fixedEndHour from duration
  if (fixedStartHour !== null && fixedEndHour === null) {
    const startTotal = fixedStartHour * 60 + fixedStartMin;
    const endTotal = startTotal + duration;
    fixedEndHour = Math.floor(endTotal / 60);
    fixedEndMin = endTotal % 60;
  }

  // Decide timeConstraintType:
  // If user mentioned an exact start-end or commitment keyword ("kelas", "rapat", "jam 7-10 malam"), it's 'fixed_event'.
  // If user mentioned a window ("malam ini", "besok sore") without exact start-end, it's 'preferred_window'.
  // Otherwise 'deadline_only'.
  let timeConstraintType: 'fixed_event' | 'preferred_window' | 'deadline_only' = 'deadline_only';
  let requestedStartAt: string | undefined = undefined;
  let requestedEndAt: string | undefined = undefined;
  let preferredWindow: { startHour: number; startMinute?: number; endHour: number; endMinute?: number; label?: string } | undefined = undefined;
  let preferredTimeOfDay: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'ANY' = 'ANY';

  if (fixedStartHour !== null && (isCommitmentKeyword || colonRangeMatch || prompt.includes('sampai') || prompt.includes('–') || prompt.includes('-'))) {
    timeConstraintType = 'fixed_event';
    const sDate = new Date(targetDate);
    sDate.setHours(fixedStartHour, fixedStartMin, 0, 0);
    const eDate = new Date(targetDate);
    eDate.setHours(fixedEndHour || fixedStartHour + 1, fixedEndMin, 0, 0);
    
    requestedStartAt = sDate.toISOString();
    requestedEndAt = eDate.toISOString();
    duration = Math.max(15, Math.round((eDate.getTime() - sDate.getTime()) / 60000));
    
    preferredTimeOfDay = fixedStartHour >= 18 ? 'EVENING' : fixedStartHour >= 12 ? 'AFTERNOON' : 'MORNING';
  } else if (fixedStartHour !== null) {
    // Single time specified like "malam ini jam 9" or "jam 21.00"
    if (isCommitmentKeyword) {
      timeConstraintType = 'fixed_event';
      const sDate = new Date(targetDate);
      sDate.setHours(fixedStartHour, fixedStartMin, 0, 0);
      const eDate = new Date(sDate.getTime() + duration * 60000);
      requestedStartAt = sDate.toISOString();
      requestedEndAt = eDate.toISOString();
      preferredTimeOfDay = fixedStartHour >= 18 ? 'EVENING' : fixedStartHour >= 12 ? 'AFTERNOON' : 'MORNING';
    } else {
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

  // Deadline calculation
  const deadlineDate = new Date(targetDate);
  if (timeConstraintType === 'fixed_event' && requestedEndAt) {
    deadlineDate.setTime(new Date(requestedEndAt).getTime());
  } else {
    // Default deadline at 18:00 on the target day or 23:00 if night
    deadlineDate.setHours(preferredTimeOfDay === 'EVENING' ? 23 : 18, 0, 0, 0);
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

  // Splitting: fixed event cannot be split!
  const allowSplit = timeConstraintType !== 'fixed_event' && (prompt.includes('bagi') || prompt.includes('sesi') || prompt.includes('cicil'));
  const minSession = 30;

  // Title generation
  let title = ctx.userPrompt.trim();
  if (title.length > 50) {
    title = title.slice(0, 47) + '...';
  }

  // Reasoning in Indonesian
  let reasoning = '';
  if (timeConstraintType === 'fixed_event') {
    reasoning = `AI mendeteksi komitmen waktu tetap (${fixedStartHour ? String(fixedStartHour).padStart(2, '0') : '00'}:${String(fixedStartMin).padStart(2, '0')} - ${fixedEndHour ? String(fixedEndHour).padStart(2, '0') : '00'}:${String(fixedEndMin).padStart(2, '0')}) sehingga dijaga tanpa digeser.`;
  } else if (preferredWindow) {
    reasoning = `AI menetapkan jendela preferensi ${preferredWindow.label} dengan durasi ${duration} menit agar sesuai dengan waktu santai atau fokus malam Anda.`;
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
    deadlineAt: deadlineDate.toISOString(),
    deadlineDaysFromNow: Math.max(1, dayOffset),
    timezone: tz,
    priority,
    allowSplit,
    minimumSessionMinutes: minSession,
    reasoning,
  };
}
