import {
  Task,
  CalendarEvent,
  UserPreferences,
  ScheduleCalculationResult,
  ScheduleFailureCode,
} from '../types';
import {
  normalizeTimezone,
  formatInUserTimezone,
  createIsoFromLocalZoned,
  getZonedDateTimeParts,
} from './timezone';

interface TimeInterval {
  start: Date;
  end: Date;
}

/**
 * Formats date into Indonesian localized string respecting user's timezone
 */
function formatIndonesianDate(d: Date, timeZone: string): string {
  return formatInUserTimezone(d, timeZone, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Formats time into HH:mm respecting user's timezone
 */
function formatTime(d: Date, timeZone: string): string {
  return formatInUserTimezone(d, timeZone, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Calculates total available free minutes across candidate segments taking busy windows and buffer into account.
 */
export function calculateFreeTimeMinutes(
  segments: TimeInterval[],
  busyWindows: TimeInterval[],
  bufferMinutes: number = 0
): { freeBlocks: TimeInterval[]; totalFreeMinutes: number } {
  const freeBlocks: TimeInterval[] = [];

  for (const seg of segments) {
    if (seg.start >= seg.end) continue;

    let currentPointer = new Date(seg.start);
    const overlappingBusy = busyWindows.filter(
      (b) => b.end > currentPointer && b.start < seg.end
    );

    for (const busy of overlappingBusy) {
      if (busy.start > currentPointer) {
        const potentialEnd = busy.start < seg.end ? busy.start : seg.end;
        const durationMin = (potentialEnd.getTime() - currentPointer.getTime()) / 60000;
        if (durationMin >= 15) {
          freeBlocks.push({
            start: new Date(currentPointer),
            end: new Date(potentialEnd),
          });
        }
      }
      if (busy.end > currentPointer) {
        const bufferedPointer = new Date(busy.end.getTime() + bufferMinutes * 60000);
        currentPointer = bufferedPointer > currentPointer ? bufferedPointer : currentPointer;
      }
    }

    if (currentPointer < seg.end) {
      const durationMin = (seg.end.getTime() - currentPointer.getTime()) / 60000;
      if (durationMin >= 15) {
        freeBlocks.push({
          start: new Date(currentPointer),
          end: new Date(seg.end),
        });
      }
    }
  }

  const totalFreeMinutes = freeBlocks.reduce(
    (acc, b) => acc + (b.end.getTime() - b.start.getTime()) / 60000,
    0
  );

  return { freeBlocks, totalFreeMinutes };
}

/**
 * Deterministic Scheduler Engine for EVEN
 * Strictly respects:
 * 1. Fixed commitments / manual schedules: placed precisely without silent shift; collision returns TIME_CONFLICT.
 * 2. Preferred time windows: Evening or user-specified windows. Never confuses night with morning.
 * 3. Work hours and buffers.
 * 4. Structured failure codes when constraints cannot be fulfilled.
 */
export function scheduleTaskDeterministically(
  task: Task,
  existingEvents: CalendarEvent[] = [],
  existingTasks: Task[] = [],
  preferences?: UserPreferences,
  referenceDate: Date = new Date()
): ScheduleCalculationResult {
  const safeEvents = Array.isArray(existingEvents) ? existingEvents : [];
  let safeTasks: Task[] = [];
  let safePreferences: UserPreferences;

  const defaultPreferences: UserPreferences = {
    displayName: 'Pengguna',
    email: '',
    timezone: 'Asia/Jakarta (WIB)',
    workStartHour: 8,
    workEndHour: 18,
    lunchStartHour: 12,
    lunchEndHour: 13,
    lunchBreakStartHour: 12,
    lunchBreakEndHour: 13,
    lunchBreakEnabled: true,
    bufferMinutes: 10,
    workDays: [1, 2, 3, 4, 5],
    googleCalendarConnected: false,
    calendarSyncStatus: 'synced',
    lastSyncedAt: null,
    allowAutoSplit: false,
  };

  if (Array.isArray(existingTasks)) {
    safeTasks = existingTasks;
    safePreferences = preferences || defaultPreferences;
  } else if (existingTasks && typeof existingTasks === 'object' && 'workStartHour' in existingTasks) {
    safeTasks = [];
    safePreferences = existingTasks as unknown as UserPreferences;
  } else {
    safeTasks = [];
    safePreferences = preferences || defaultPreferences;
  }

  const tz = normalizeTimezone(task.timezone || safePreferences.timezone || 'Asia/Jakarta');
  const durationNeeded = task.estimatedDurationMinutes || 60;

  // -------------------------------------------------------------
  // 1. HARD CONSTRAINT: FIXED COMMITMENT OR MANUAL SCHEDULE
  // -------------------------------------------------------------
  const isFixedEvent =
    task.timeConstraintType === 'fixed_event' &&
    Boolean(task.requestedStartAt) &&
    Boolean(task.requestedEndAt);

  if (isFixedEvent && task.requestedStartAt && task.requestedEndAt) {
    const fixedStart = new Date(task.requestedStartAt);
    const fixedEnd = new Date(task.requestedEndAt);

    if (isNaN(fixedStart.getTime()) || isNaN(fixedEnd.getTime()) || fixedEnd <= fixedStart) {
      return {
        success: false,
        taskId: task.id,
        taskTitle: task.title,
        failureCode: 'INVALID_TIME_RANGE',
        proposedSessions: [],
        explanation: 'Format rentang waktu komitmen tetap (requestedStartAt / requestedEndAt) tidak valid atau jam selesai mendahului jam mulai.',
        warning: 'Periksa kembali input tanggal dan jam yang Anda tentukan.',
        diagnostics: {
          calendarEventsCount: safeEvents.length,
        },
      };
    }

    // Check collision against calendar events
    const conflictingEvents: string[] = [];
    for (const evt of safeEvents) {
      const eStart = new Date(evt.startAt);
      const eEnd = new Date(evt.endAt);
      if (fixedStart < eEnd && fixedEnd > eStart) {
        conflictingEvents.push(`[Acara] ${evt.title} (${formatTime(eStart, tz)} - ${formatTime(eEnd, tz)})`);
      }
    }

    // Check collision against other scheduled task sessions
    for (const t of safeTasks) {
      if (t.id === task.id) continue;
      if (t.scheduledSessions && t.scheduledSessions.length > 0) {
        for (const s of t.scheduledSessions) {
          if (s.status !== 'CANCELLED') {
            const sStart = new Date(s.startAt);
            const sEnd = new Date(s.endAt);
            if (fixedStart < sEnd && fixedEnd > sStart) {
              conflictingEvents.push(`[Tugas] ${t.title} sesi ${s.sessionIndex} (${formatTime(sStart, tz)} - ${formatTime(sEnd, tz)})`);
            }
          }
        }
      }
    }

    if (conflictingEvents.length > 0) {
      return {
        success: false,
        taskId: task.id,
        taskTitle: task.title,
        failureCode: 'TIME_CONFLICT',
        proposedSessions: [],
        explanation: `Konflik jadwal: Komitmen waktu tetap (${formatTime(fixedStart, tz)} - ${formatTime(fixedEnd, tz)}) bertabrakan dengan: ${conflictingEvents.join(', ')}. Komitmen waktu tetap tidak dapat digeser secara otomatis.`,
        warning: 'Silakan sesuaikan jam komitmen atau pindahkan agenda yang bertabrakan di kalender.',
        diagnostics: {
          conflictingEvents,
          calendarEventsCount: safeEvents.length,
        },
      };
    }

    // No collision: Place fixed event precisely
    const fixedDuration = Math.round((fixedEnd.getTime() - fixedStart.getTime()) / 60000);
    const dayStr = formatIndonesianDate(fixedStart, tz);
    const startParts = getZonedDateTimeParts(fixedStart, tz);
    const endParts = getZonedDateTimeParts(fixedEnd, tz);
    const isNextDay = endParts.day !== startParts.day || endParts.month !== startParts.month;

    const timeStr = isNextDay
      ? `${formatTime(fixedStart, tz)} WIB hingga ${formatIndonesianDate(fixedEnd, tz)}, pukul ${formatTime(fixedEnd, tz)} WIB (+1 hari)`
      : `${formatTime(fixedStart, tz)} - ${formatTime(fixedEnd, tz)} WIB`;

    return {
      success: true,
      taskId: task.id,
      taskTitle: task.title,
      proposedSessions: [
        {
          startAt: fixedStart.toISOString(),
          endAt: fixedEnd.toISOString(),
          durationMinutes: fixedDuration,
          sessionIndex: 1,
          totalSessions: 1,
        },
      ],
      explanation: `Komitmen waktu tetap berhasil ditempatkan pada ${dayStr}, pukul ${timeStr}. Jadwal ini dikunci tepat sesuai waktu yang Anda minta.`,
      diagnostics: {
        calendarEventsCount: safeEvents.length,
        conflictingEvents: [],
      },
    };
  }

  // -------------------------------------------------------------
  // 2. FLEXIBLE TASKS WITH PREFERRED WINDOW OR DEADLINE
  // -------------------------------------------------------------
  let deadline = task.deadlineAt ? new Date(task.deadlineAt) : null;
  if (!deadline || isNaN(deadline.getTime())) {
    // If no deadline specified, default to 3 days ahead in user timezone at 23:59:59
    const refParts = getZonedDateTimeParts(referenceDate, tz);
    const defaultDeadlineIso = createIsoFromLocalZoned(
      refParts.year,
      refParts.month,
      refParts.day + 3,
      23,
      59,
      59,
      tz
    );
    deadline = new Date(defaultDeadlineIso);
  }

  if (deadline.getTime() <= referenceDate.getTime()) {
    return {
      success: false,
      taskId: task.id,
      taskTitle: task.title,
      failureCode: 'DEADLINE_PASSED',
      proposedSessions: [],
      explanation: `Tenggat waktu (${formatIndonesianDate(deadline, tz)}, ${formatTime(deadline, tz)}) sudah lewat dari waktu saat ini.`,
      warning: 'Perpanjang tenggat waktu agar perencana dapat mengalokasikan slot baru.',
      diagnostics: {
        calendarEventsCount: safeEvents.length,
      },
    };
  }

  // Collect busy intervals
  const busyWindows: TimeInterval[] = [];

  for (const event of safeEvents) {
    const s = new Date(event.startAt);
    const e = new Date(event.endAt);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
      busyWindows.push({ start: s, end: e });
    }
  }

  for (const t of safeTasks) {
    if (t.id === task.id) continue;
    if (t.scheduledSessions) {
      for (const session of t.scheduledSessions) {
        if (session.status !== 'CANCELLED') {
          const s = new Date(session.startAt);
          const e = new Date(session.endAt);
          if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
            busyWindows.push({ start: s, end: e });
          }
        }
      }
    }
  }

  busyWindows.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Build candidate days in user timezone
  const maxSearchDays = 14;
  const candidateDayStarts: { date: Date; year: number; month: number; day: number; dayOfWeek: number }[] = [];
  const refParts = getZonedDateTimeParts(referenceDate, tz);

  for (let d = 0; d < maxSearchDays; d++) {
    // Generate day midnight in user timezone
    const dayIso = createIsoFromLocalZoned(
      refParts.year,
      refParts.month,
      refParts.day + d,
      0,
      0,
      0,
      tz
    );
    const dayDate = new Date(dayIso);
    const parts = getZonedDateTimeParts(dayDate, tz);

    // Day of week calculation (0 = Sunday, 1 = Monday, etc.)
    const dObj = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const dayOfWeek = dObj.getUTCDay();

    const isPreferredWindowSpecified =
      Boolean(task.preferredWindow) || task.preferredTimeOfDay === 'EVENING';

    const workDaysList = safePreferences.workDays || [1, 2, 3, 4, 5];
    if (workDaysList.includes(dayOfWeek) || (isPreferredWindowSpecified && d === 0)) {
      candidateDayStarts.push({
        date: dayDate,
        year: parts.year,
        month: parts.month,
        day: parts.day,
        dayOfWeek,
      });
    }
  }

  const hasEveningPref =
    task.preferredTimeOfDay === 'EVENING' ||
    (task.preferredWindow && task.preferredWindow.startHour >= 18);

  const preferredWindowStartHour = task.preferredWindow
    ? task.preferredWindow.startHour
    : hasEveningPref
    ? 19
    : task.preferredTimeOfDay === 'MORNING'
    ? 8
    : task.preferredTimeOfDay === 'AFTERNOON'
    ? 13
    : null;

  const preferredWindowEndHour = task.preferredWindow
    ? task.preferredWindow.endHour
    : hasEveningPref
    ? 23
    : task.preferredTimeOfDay === 'MORNING'
    ? 12
    : task.preferredTimeOfDay === 'AFTERNOON'
    ? 18
    : null;

  const searchStart = new Date(referenceDate);

  // Helper to construct bounded segments
  const boundSegments = (rawSegments: TimeInterval[]): TimeInterval[] => {
    const bounded: TimeInterval[] = [];
    for (const seg of rawSegments) {
      const segStart = seg.start > searchStart ? seg.start : searchStart;
      const segEnd = seg.end < deadline! ? seg.end : deadline!;
      if (segStart < segEnd) {
        bounded.push({ start: segStart, end: segEnd });
      }
    }
    return bounded;
  };

  let totalSlotsEvaluated = 0;

  // -------------------------------------------------------------
  // Phase A: Search within PREFERRED WINDOW (if requested)
  // -------------------------------------------------------------
  if (preferredWindowStartHour !== null && preferredWindowEndHour !== null) {
    const preferredSegments: TimeInterval[] = [];

    for (const cDay of candidateDayStarts) {
      const pStartIso = createIsoFromLocalZoned(
        cDay.year,
        cDay.month,
        cDay.day,
        preferredWindowStartHour,
        task.preferredWindow?.startMinute || 0,
        0,
        tz
      );
      const pEndIso = createIsoFromLocalZoned(
        cDay.year,
        cDay.month,
        cDay.day,
        preferredWindowEndHour,
        task.preferredWindow?.endMinute || 0,
        0,
        tz
      );

      const pStart = new Date(pStartIso);
      const pEnd = new Date(pEndIso);

      if (pEnd > pStart) {
        preferredSegments.push({ start: pStart, end: pEnd });
      }
    }

    const boundedPref = boundSegments(preferredSegments);
    const { freeBlocks: preferredFreeBlocks, totalFreeMinutes: prefFreeMinutes } =
      calculateFreeTimeMinutes(boundedPref, busyWindows, safePreferences.bufferMinutes);

    totalSlotsEvaluated += preferredFreeBlocks.length;

    // Try contiguous fit
    for (const block of preferredFreeBlocks) {
      const blockDuration = (block.end.getTime() - block.start.getTime()) / 60000;
      if (blockDuration >= durationNeeded) {
        const slotStart = new Date(block.start);
        const slotEnd = new Date(slotStart.getTime() + durationNeeded * 60000);

        const dayStr = formatIndonesianDate(slotStart, tz);
        const timeStr = `${formatTime(slotStart, tz)} - ${formatTime(slotEnd, tz)}`;
        const windowDesc = task.preferredWindow?.label || (hasEveningPref ? 'malam' : 'pilihan');

        return {
          success: true,
          taskId: task.id,
          taskTitle: task.title,
          proposedSessions: [
            {
              startAt: slotStart.toISOString(),
              endAt: slotEnd.toISOString(),
              durationMinutes: durationNeeded,
              sessionIndex: 1,
              totalSessions: 1,
            },
          ],
          explanation: `Ditemukan waktu fokus ${durationNeeded} menit pada ${dayStr}, pukul ${timeStr} WIB tepat di jendela waktu ${windowDesc} yang Anda inginkan.`,
          diagnostics: {
            freeTimeCalculatedMinutes: Math.round(prefFreeMinutes),
            totalSlotsEvaluated,
            calendarEventsCount: existingEvents.length,
          },
        };
      }
    }

    // Try split sessions within preferred windows if allowed
    if (task.allowSplit) {
      const minSession = task.minimumSessionMinutes || 30;
      let remainingMinutes = durationNeeded;
      const splitSessions: ScheduleCalculationResult['proposedSessions'] = [];

      for (const block of preferredFreeBlocks) {
        if (remainingMinutes <= 0) break;

        const blockDuration = (block.end.getTime() - block.start.getTime()) / 60000;
        if (blockDuration < minSession) continue;

        const allocDuration = Math.min(blockDuration, remainingMinutes);
        if (allocDuration < minSession) continue;

        const sessionStart = new Date(block.start);
        const sessionEnd = new Date(sessionStart.getTime() + allocDuration * 60000);

        splitSessions.push({
          startAt: sessionStart.toISOString(),
          endAt: sessionEnd.toISOString(),
          durationMinutes: allocDuration,
          sessionIndex: splitSessions.length + 1,
          totalSessions: 0,
        });

        remainingMinutes -= allocDuration;
      }

      if (remainingMinutes <= 0 && splitSessions.length > 0) {
        const total = splitSessions.length;
        splitSessions.forEach((s) => (s.totalSessions = total));

        const first = splitSessions[0];
        return {
          success: true,
          taskId: task.id,
          taskTitle: task.title,
          proposedSessions: splitSessions,
          explanation: `Tugas dipecah menjadi ${total} sesi realistis di jendela waktu ${task.preferredWindow?.label || 'malam'} yang diminta. Sesi pertama mulai ${formatIndonesianDate(new Date(first.startAt), tz)}, pukul ${formatTime(new Date(first.startAt), tz)} WIB.`,
          diagnostics: {
            freeTimeCalculatedMinutes: Math.round(prefFreeMinutes),
            totalSlotsEvaluated,
            calendarEventsCount: existingEvents.length,
          },
        };
      }
    }

    // If explicit evening preference or preferred window, do NOT silently displace to morning!
    if (hasEveningPref || task.timeConstraintType === 'preferred_window') {
      const windowName = task.preferredWindow?.label || 'malam (19:00 - 23:00)';
      return {
        success: false,
        taskId: task.id,
        taskTitle: task.title,
        failureCode: 'PREFERRED_WINDOW_FULL',
        proposedSessions: [],
        explanation: `Tidak ditemukan slot waktu luang yang mencukupi (${durationNeeded} menit) di jendela waktu ${windowName} sebelum tenggat waktu (${formatIndonesianDate(deadline, tz)}, ${formatTime(deadline, tz)}). Waktu luang tersisa di jendela ini hanya ${Math.round(prefFreeMinutes)} menit.`,
        warning: task.allowSplit
          ? 'Pertimbangkan untuk memperpanjang batas tenggat atau mengurangi durasi tugas.'
          : 'Saran: Anda dapat mengaktifkan opsi "Boleh dipecah menjadi beberapa sesi" atau memperpanjang tenggat waktu.',
        diagnostics: {
          freeTimeCalculatedMinutes: Math.round(prefFreeMinutes),
          totalSlotsEvaluated,
          calendarEventsCount: existingEvents.length,
        },
      };
    }
  }

  // -------------------------------------------------------------
  // Phase B: Standard Work Hours Search (based on configured preferences)
  // -------------------------------------------------------------
  const standardSegments: TimeInterval[] = [];

  const lunchStart = typeof safePreferences.lunchBreakStartHour === 'number'
    ? safePreferences.lunchBreakStartHour
    : (safePreferences as any).lunchStartHour ?? 12;
  const lunchEnd = typeof safePreferences.lunchBreakEndHour === 'number'
    ? safePreferences.lunchBreakEndHour
    : (safePreferences as any).lunchEndHour ?? 13;

  const hasLunch =
    safePreferences.lunchBreakEnabled !== false &&
    lunchEnd > lunchStart &&
    lunchStart >= safePreferences.workStartHour &&
    lunchEnd <= safePreferences.workEndHour;

  for (const cDay of candidateDayStarts) {
    const workStartIso = createIsoFromLocalZoned(cDay.year, cDay.month, cDay.day, safePreferences.workStartHour, 0, 0, tz);
    const workEndIso = createIsoFromLocalZoned(cDay.year, cDay.month, cDay.day, safePreferences.workEndHour, 0, 0, tz);

    if (hasLunch) {
      const lunchStartIso = createIsoFromLocalZoned(cDay.year, cDay.month, cDay.day, lunchStart, 0, 0, tz);
      const lunchEndIso = createIsoFromLocalZoned(cDay.year, cDay.month, cDay.day, lunchEnd, 0, 0, tz);

      if (lunchStart > safePreferences.workStartHour) {
        standardSegments.push({ start: new Date(workStartIso), end: new Date(lunchStartIso) });
      }
      if (safePreferences.workEndHour > lunchEnd) {
        standardSegments.push({ start: new Date(lunchEndIso), end: new Date(workEndIso) });
      }
    } else {
      standardSegments.push({ start: new Date(workStartIso), end: new Date(workEndIso) });
    }
  }

  const boundedStd = boundSegments(standardSegments);
  const { freeBlocks: standardFreeBlocks, totalFreeMinutes: stdFreeMinutes } =
    calculateFreeTimeMinutes(boundedStd, busyWindows, safePreferences.bufferMinutes);

  totalSlotsEvaluated += standardFreeBlocks.length;

  // Contiguous slot in standard hours
  for (const block of standardFreeBlocks) {
    const blockDuration = (block.end.getTime() - block.start.getTime()) / 60000;
    if (blockDuration >= durationNeeded) {
      const slotStart = new Date(block.start);
      const slotEnd = new Date(slotStart.getTime() + durationNeeded * 60000);

      const dayStr = formatIndonesianDate(slotStart, tz);
      const timeStr = `${formatTime(slotStart, tz)} - ${formatTime(slotEnd, tz)}`;

      return {
        success: true,
        taskId: task.id,
        taskTitle: task.title,
        proposedSessions: [
          {
            startAt: slotStart.toISOString(),
            endAt: slotEnd.toISOString(),
            durationMinutes: durationNeeded,
            sessionIndex: 1,
            totalSessions: 1,
          },
        ],
        explanation: `Ditemukan waktu fokus penuh ${durationNeeded} menit pada ${dayStr}, pukul ${timeStr} WIB.`,
        diagnostics: {
          freeTimeCalculatedMinutes: Math.round(stdFreeMinutes),
          totalSlotsEvaluated,
          calendarEventsCount: safeEvents.length,
        },
      };
    }
  }

  // Split sessions in standard hours
  if (task.allowSplit) {
    const minSession = task.minimumSessionMinutes || 30;
    let remainingMinutes = durationNeeded;
    const splitSessions: ScheduleCalculationResult['proposedSessions'] = [];

    for (const block of standardFreeBlocks) {
      if (remainingMinutes <= 0) break;

      const blockDuration = (block.end.getTime() - block.start.getTime()) / 60000;
      if (blockDuration < minSession) continue;

      const allocDuration = Math.min(blockDuration, remainingMinutes);
      if (allocDuration < minSession) continue;

      const sessionStart = new Date(block.start);
      const sessionEnd = new Date(sessionStart.getTime() + allocDuration * 60000);

      splitSessions.push({
        startAt: sessionStart.toISOString(),
        endAt: sessionEnd.toISOString(),
        durationMinutes: allocDuration,
        sessionIndex: splitSessions.length + 1,
        totalSessions: 0,
      });

      remainingMinutes -= allocDuration;
    }

    if (remainingMinutes <= 0 && splitSessions.length > 0) {
      const total = splitSessions.length;
      splitSessions.forEach((s) => (s.totalSessions = total));

      const first = splitSessions[0];
      return {
        success: true,
        taskId: task.id,
        taskTitle: task.title,
        proposedSessions: splitSessions,
        explanation: `Tugas dipecah menjadi ${total} sesi realistis (total ${durationNeeded} menit). Sesi pertama dimulai ${formatIndonesianDate(new Date(first.startAt), tz)}, pukul ${formatTime(new Date(first.startAt), tz)} WIB.`,
        diagnostics: {
          freeTimeCalculatedMinutes: Math.round(stdFreeMinutes),
          totalSlotsEvaluated,
          calendarEventsCount: safeEvents.length,
        },
      };
    }
  }

  // Phase C: No slot available before deadline
  return {
    success: false,
    taskId: task.id,
    taskTitle: task.title,
    failureCode: 'NO_SLOT_BEFORE_DEADLINE',
    proposedSessions: [],
    explanation: `Tidak ditemukan slot waktu kosong yang mencukupi durasi (${durationNeeded} menit) sebelum tenggat (${formatIndonesianDate(deadline, tz)}, ${formatTime(deadline, tz)}). Total waktu luang tersisa di jam kerja kalender Anda hanya ${Math.round(stdFreeMinutes)} menit.`,
    warning: task.allowSplit
      ? 'Pertimbangkan untuk memperpanjang tenggat atau mengurangi durasi tugas.'
      : 'Saran: Anda dapat mengaktifkan opsi "Boleh dipecah menjadi beberapa sesi" atau memperpanjang tenggat waktu.',
    diagnostics: {
      freeTimeCalculatedMinutes: Math.round(stdFreeMinutes),
      totalSlotsEvaluated,
      calendarEventsCount: safeEvents.length,
    },
  };
}

/**
 * Batch schedules multiple tasks deterministically by priority, hard constraints, and deadline.
 * Fixed events and urgent tasks are scheduled first to guarantee non-displacement.
 */
export function scheduleAllPendingTasks(
  tasks: Task[],
  existingEvents: CalendarEvent[],
  preferences: UserPreferences
): { results: ScheduleCalculationResult[]; updatedTasks: Task[] } {
  const pending = tasks.filter((t) => t.status === 'UNSCHEDULED');

  const priorityScore: Record<string, number> = {
    URGENT: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
  };

  // Sort: Fixed events FIRST (score 100), then priority, then earliest deadline
  const sortedPending = [...pending].sort((a, b) => {
    const isFixedA = a.timeConstraintType === 'fixed_event' ? 100 : 0;
    const isFixedB = b.timeConstraintType === 'fixed_event' ? 100 : 0;
    if (isFixedB !== isFixedA) return isFixedB - isFixedA;

    const pA = priorityScore[a.priority] || 0;
    const pB = priorityScore[b.priority] || 0;
    if (pB !== pA) return pB - pA;

    const deadlineA = a.deadlineAt ? new Date(a.deadlineAt).getTime() : Infinity;
    const deadlineB = b.deadlineAt ? new Date(b.deadlineAt).getTime() : Infinity;
    return deadlineA - deadlineB;
  });

  const results: ScheduleCalculationResult[] = [];
  const runningTasks = [...tasks];

  for (const t of sortedPending) {
    const res = scheduleTaskDeterministically(t, existingEvents, runningTasks, preferences);
    results.push(res);

    if (res.success && res.proposedSessions.length > 0) {
      const targetIndex = runningTasks.findIndex((item) => item.id === t.id);
      if (targetIndex >= 0) {
        runningTasks[targetIndex] = {
          ...runningTasks[targetIndex],
          status: 'SCHEDULED',
          scheduledSessions: res.proposedSessions.map((s) => ({
            id: `session-${t.id}-${s.sessionIndex}-${Date.now()}`,
            taskId: t.id,
            taskTitle: t.title,
            sessionIndex: s.sessionIndex,
            totalSessions: s.totalSessions,
            startAt: s.startAt,
            endAt: s.endAt,
            durationMinutes: s.durationMinutes,
            status: 'SCHEDULED',
            syncStatus: preferences.googleCalendarConnected ? 'synced' : 'pending',
          })),
        };
      }
    }
  }

  return { results, updatedTasks: runningTasks };
}
