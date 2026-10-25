import { Task, CalendarEvent, UserPreferences, ScheduleCalculationResult } from '../types';
import {
  parseTimezoneString,
  getPartsInTimezone,
  createIsoInTimezone,
  formatInTimezone,
} from './timezone';

interface TimeInterval {
  start: Date;
  end: Date;
}

function formatIndonesianDate(d: Date, tz: string = 'Asia/Jakarta'): string {
  return formatInTimezone(d, tz, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
}

function formatTime(d: Date, tz: string = 'Asia/Jakarta'): string {
  return formatInTimezone(d, tz, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Deterministic Scheduler Engine for EVEN
 * Strictly respects:
 * 1. Fixed events: Cannot be shifted; placed precisely at requestedStartAt - requestedEndAt; checks collisions.
 * 2. Preferred time windows: Evening (19:00-23:00) or user-specified windows.
 * 3. Never confuses night (e.g. 21:00) with morning (05:00 or 09:00).
 * 4. Deterministic non-overlapping slot allocation with buffers and split session support.
 * 5. Timezone-aware slot generation (Asia/Jakarta default).
 */
export function scheduleTaskDeterministically(
  task: Task,
  existingEvents: CalendarEvent[],
  existingTasks: Task[],
  preferences: UserPreferences,
  referenceDate: Date = new Date()
): ScheduleCalculationResult {
  const durationNeeded = task.estimatedDurationMinutes || 60;
  const userTz = parseTimezoneString(task.timezone || preferences.timezone || 'Asia/Jakarta');

  // -------------------------------------------------------------
  // 1. HARD CONSTRAINT: FIXED COMMITMENT (fixed_event)
  // -------------------------------------------------------------
  // CRITICAL: A task is ONLY a fixed event if its timeConstraintType is explicitly 'fixed_event'!
  // A preferred_window task with an accidental requestedStartAt MUST NEVER be treated as fixed_event!
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
        proposedSessions: [],
        explanation: 'Format waktu komitmen tetap (requestedStartAt / requestedEndAt) tidak valid.',
      };
    }

    // Check collision against calendar events
    for (const evt of existingEvents) {
      const eStart = new Date(evt.startAt);
      const eEnd = new Date(evt.endAt);
      if (fixedStart < eEnd && fixedEnd > eStart) {
        return {
          success: false,
          taskId: task.id,
          taskTitle: task.title,
          proposedSessions: [],
          explanation: `Konflik jadwal: Komitmen tetap (${formatTime(fixedStart, userTz)} - ${formatTime(fixedEnd, userTz)}) bertabrakan dengan acara kalender "${evt.title}" (${formatTime(eStart, userTz)} - ${formatTime(eEnd, userTz)}). Komitmen waktu tetap tidak dapat digeser secara otomatis.`,
          warning: 'Silakan sesuaikan jam komitmen atau pindahkan acara yang bertabrakan di Google Calendar.',
        };
      }
    }

    // Check collision against other scheduled task sessions
    for (const t of existingTasks) {
      if (t.id === task.id) continue;
      // Skip tasks that have moved to history
      if (t.status === 'completed_manual' || t.status === 'missed_auto' || t.status === 'COMPLETED') continue;
      if (t.scheduledSessions && t.scheduledSessions.length > 0) {
        for (const s of t.scheduledSessions) {
          if (
            s.status !== 'CANCELLED' &&
            s.status !== 'completed_manual' &&
            s.status !== 'missed_auto' &&
            s.status !== 'COMPLETED'
          ) {
            const sStart = new Date(s.startAt);
            const sEnd = new Date(s.endAt);
            if (fixedStart < sEnd && fixedEnd > sStart) {
              return {
                success: false,
                taskId: task.id,
                taskTitle: task.title,
                failureCode: 'TIME_CONFLICT',
                proposedSessions: [],
                explanation: `Konflik jadwal: Komitmen tetap bertabrakan dengan kegiatan "${t.title}" sesi ${s.sessionIndex} (${formatTime(sStart, userTz)} - ${formatTime(sEnd, userTz)}).`,
                warning: 'Jadwal waktu tetap memerlukan slot kosong tanpa tabrakan kegiatan lain.',
              };
            }
          }
        }
      }
    }

    // No collision found! Place fixed event precisely
    const fixedDuration = Math.round((fixedEnd.getTime() - fixedStart.getTime()) / 60000);
    const dayStr = formatIndonesianDate(fixedStart, userTz);
    const timeStr = `${formatTime(fixedStart, userTz)} - ${formatTime(fixedEnd, userTz)}`;

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
      explanation: `Komitmen waktu tetap berhasil ditempatkan pada ${dayStr}, pukul ${timeStr} WIB. Jadwal ini dikunci tepat sesuai waktu yang Anda minta.`,
    };
  }

  // -------------------------------------------------------------
  // 2. FLEXIBLE TASKS WITH PREFERRED WINDOW OR DEADLINE
  // -------------------------------------------------------------
  const hasExplicitDeadline = Boolean(task.deadlineAt && task.deadlineAt.trim().length > 0);
  let deadline: Date | null = null;

  if (hasExplicitDeadline && task.deadlineAt) {
    const parsed = new Date(task.deadlineAt);
    if (!isNaN(parsed.getTime())) {
      deadline = parsed;
    }
  }

  if (deadline && deadline.getTime() <= referenceDate.getTime()) {
    return {
      success: false,
      taskId: task.id,
      taskTitle: task.title,
      failureCode: 'DEADLINE_PASSED',
      proposedSessions: [],
      explanation: `Tenggat waktu (${formatIndonesianDate(deadline, userTz)}, ${formatTime(deadline, userTz)}) sudah lewat dari waktu saat ini.`,
    };
  }

  // Collect busy windows from calendar events and existing task sessions
  const busyWindows: TimeInterval[] = [];

  for (const event of existingEvents) {
    const s = new Date(event.startAt);
    const e = new Date(event.endAt);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
      busyWindows.push({ start: s, end: e });
    }
  }

  for (const t of existingTasks) {
    if (t.id === task.id) continue;
    // Skip tasks that have moved to history - they must not block future slots
    if (t.status === 'completed_manual' || t.status === 'missed_auto' || t.status === 'COMPLETED') continue;
    if (t.scheduledSessions) {
      for (const session of t.scheduledSessions) {
        if (
          session.status !== 'CANCELLED' &&
          session.status !== 'completed_manual' &&
          session.status !== 'missed_auto' &&
          session.status !== 'COMPLETED'
        ) {
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

  // Search horizon: If deadline is specified, cap search by deadline; otherwise search up to 21 days
  const maxSearchDays = hasExplicitDeadline ? 14 : 21;
  const candidateDays: { year: number; month: number; day: number; dayOfWeek: number; dateObj: Date }[] = [];
  const searchStart = new Date(referenceDate);

  for (let d = 0; d < maxSearchDays; d++) {
    const dayObj = new Date(searchStart.getTime() + d * 86400000);
    const parts = getPartsInTimezone(dayObj, userTz);
    const isPreferredWindowSpecified =
      Boolean(task.preferredWindow) || task.preferredTimeOfDay === 'EVENING' || task.preferredTimeOfDay === 'MORNING';

    const activeWorkDays = preferences.workDays || [1, 2, 3, 4, 5];
    if (activeWorkDays.includes(parts.dayOfWeek) || (isPreferredWindowSpecified && d <= 1)) {
      candidateDays.push({ ...parts, dateObj: dayObj });
    }
  }

  // Determine user preferred time window (if any)
  const hasEveningPref =
    task.preferredTimeOfDay === 'EVENING' ||
    (task.preferredWindow && task.preferredWindow.startHour >= 18);

  const hasMorningPref =
    task.preferredTimeOfDay === 'MORNING' ||
    (task.preferredWindow && task.preferredWindow.endHour <= 12);

  const preferredWindowStartHour = task.preferredWindow
    ? task.preferredWindow.startHour
    : hasEveningPref
    ? 19
    : hasMorningPref
    ? 8
    : task.preferredTimeOfDay === 'AFTERNOON'
    ? 13
    : null;

  const preferredWindowEndHour = task.preferredWindow
    ? task.preferredWindow.endHour
    : hasEveningPref
    ? 23
    : hasMorningPref
    ? 12
    : task.preferredTimeOfDay === 'AFTERNOON'
    ? 18
    : null;

  // Helper to extract free blocks
  const extractFreeBlocks = (segments: TimeInterval[]): TimeInterval[] => {
    const free: TimeInterval[] = [];

    for (const seg of segments) {
      const segStart = seg.start > searchStart ? seg.start : searchStart;
      const segEnd = deadline && seg.end > deadline ? deadline : seg.end;

      if (segStart >= segEnd) continue;

      let currentPointer = new Date(segStart);
      const overlappingBusy = busyWindows.filter(
        (b) => b.end > currentPointer && b.start < segEnd
      );

      for (const busy of overlappingBusy) {
        if (busy.start > currentPointer) {
          const potentialEnd = busy.start < segEnd ? busy.start : segEnd;
          const freeDuration = (potentialEnd.getTime() - currentPointer.getTime()) / 60000;
          if (freeDuration >= 15) {
            free.push({
              start: new Date(currentPointer),
              end: new Date(potentialEnd),
            });
          }
        }
        if (busy.end > currentPointer) {
          const bufferedPointer = new Date(
            busy.end.getTime() + preferences.bufferMinutes * 60 * 1000
          );
          currentPointer = bufferedPointer > currentPointer ? bufferedPointer : currentPointer;
        }
      }

      if (currentPointer < segEnd) {
        const freeDuration = (segEnd.getTime() - currentPointer.getTime()) / 60000;
        if (freeDuration >= 15) {
          free.push({
            start: new Date(currentPointer),
            end: new Date(segEnd),
          });
        }
      }
    }
    return free;
  };

  // Phase A: Search within PREFERRED WINDOW first (if requested)
  if (preferredWindowStartHour !== null && preferredWindowEndHour !== null) {
    const preferredSegments: TimeInterval[] = [];

    for (const day of candidateDays) {
      const pStartIso = createIsoInTimezone(
        day.year,
        day.month,
        day.day,
        preferredWindowStartHour,
        task.preferredWindow?.startMinute || 0,
        0,
        userTz
      );
      const pEndIso = createIsoInTimezone(
        day.year,
        day.month,
        day.day,
        preferredWindowEndHour,
        task.preferredWindow?.endMinute || 0,
        0,
        userTz
      );

      const pStart = new Date(pStartIso);
      const pEnd = new Date(pEndIso);

      if (pEnd > pStart) {
        preferredSegments.push({ start: pStart, end: pEnd });
      }
    }

    const preferredFreeBlocks = extractFreeBlocks(preferredSegments);

    // Contiguous fit in preferred window
    for (const block of preferredFreeBlocks) {
      const blockDuration = (block.end.getTime() - block.start.getTime()) / 60000;
      if (blockDuration >= durationNeeded) {
        const slotStart = new Date(block.start);
        const slotEnd = new Date(slotStart.getTime() + durationNeeded * 60000);

        const dayStr = formatIndonesianDate(slotStart, userTz);
        const timeStr = `${formatTime(slotStart, userTz)} - ${formatTime(slotEnd, userTz)}`;
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
        };
      }
    }

    // Split sessions in preferred window if allowed
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
          explanation: `Kegiatan dipecah menjadi ${total} sesi realistis di jendela waktu ${task.preferredWindow?.label || 'malam'} yang diminta. Sesi pertama mulai ${formatIndonesianDate(new Date(first.startAt), userTz)}, pukul ${formatTime(new Date(first.startAt), userTz)} WIB.`,
        };
      }
    }
  }

  // If task has explicit evening preference or preferred window, do NOT silently fall back to daytime work hours!
  if (hasEveningPref || task.timeConstraintType === 'preferred_window' || hasMorningPref) {
    const windowName = task.preferredWindow?.label || (hasEveningPref ? 'malam (19:00 - 23:00)' : 'pagi (06:00 - 12:00)');
    const deadlineText = deadline
      ? ` sebelum tenggat (${formatIndonesianDate(deadline, userTz)}, ${formatTime(deadline, userTz)})`
      : '';
    return {
      success: false,
      taskId: task.id,
      taskTitle: task.title,
      failureCode: 'PREFERRED_WINDOW_FULL',
      proposedSessions: [],
      explanation: `Tidak ditemukan slot waktu luang yang mencukupi (${durationNeeded} menit) di jendela waktu ${windowName}${deadlineText}. Jadwal pada jendela waktu tersebut penuh atau terhalang agenda lain.`,
      warning: task.allowSplit
        ? 'Pertimbangkan untuk memperpanjang batas tenggat atau mengurangi durasi kegiatan.'
        : 'Saran: Anda dapat mengaktifkan opsi "Boleh dipecah menjadi beberapa sesi" atau menyesuaikan preferensi waktu.',
    };
  }

  // Phase B: Standard / Night Shift Work Hours Search (01:00 - 24:00)
  const workStartHour = preferences.workStartHour ?? 9;
  const workEndHour = preferences.workEndHour ?? 18;
  const isNightShift = workEndHour < workStartHour;
  const enableLunch = preferences.enableLunchBreak !== false;
  const lunchStartHour = preferences.lunchStartHour ?? 12;
  const lunchEndHour = preferences.lunchEndHour ?? 13;

  const workSegments: TimeInterval[] = [];

  for (const day of candidateDays) {
    if (isNightShift) {
      // Night shift crossing midnight: starts on `day` at workStartHour, ends on `day + 1` at workEndHour
      const shiftStartIso = createIsoInTimezone(day.year, day.month, day.day, workStartHour, 0, 0, userTz);
      const nextDayDate = new Date(day.dateObj.getTime() + 86400000);
      const nextParts = getPartsInTimezone(nextDayDate, userTz);
      const shiftEndIso = createIsoInTimezone(nextParts.year, nextParts.month, nextParts.day, workEndHour, 0, 0, userTz);

      const shiftStart = new Date(shiftStartIso);
      const shiftEnd = new Date(shiftEndIso);

      if (enableLunch && lunchStartHour && lunchEndHour) {
        // If lunch is configured, check if lunch falls within shift
        const lunchStartIso = createIsoInTimezone(day.year, day.month, day.day, lunchStartHour, 0, 0, userTz);
        const lunchEndIso = createIsoInTimezone(day.year, day.month, day.day, lunchEndHour, 0, 0, userTz);
        const lunchStart = new Date(lunchStartIso);
        const lunchEnd = new Date(lunchEndIso);

        if (lunchStart > shiftStart && lunchEnd < shiftEnd) {
          workSegments.push({ start: shiftStart, end: lunchStart });
          workSegments.push({ start: lunchEnd, end: shiftEnd });
        } else {
          workSegments.push({ start: shiftStart, end: shiftEnd });
        }
      } else {
        workSegments.push({ start: shiftStart, end: shiftEnd });
      }
    } else {
      // Day shift within same day
      const shiftStartIso = createIsoInTimezone(day.year, day.month, day.day, workStartHour, 0, 0, userTz);
      // If workEndHour is 24, createIsoInTimezone automatically rolls to next day 00:00:00
      const shiftEndIso = createIsoInTimezone(day.year, day.month, day.day, workEndHour, 0, 0, userTz);

      const shiftStart = new Date(shiftStartIso);
      const shiftEnd = new Date(shiftEndIso);

      if (enableLunch && lunchStartHour && lunchEndHour && lunchStartHour < lunchEndHour) {
        const lunchStartIso = createIsoInTimezone(day.year, day.month, day.day, lunchStartHour, 0, 0, userTz);
        const lunchEndIso = createIsoInTimezone(day.year, day.month, day.day, lunchEndHour, 0, 0, userTz);
        const lunchStart = new Date(lunchStartIso);
        const lunchEnd = new Date(lunchEndIso);

        if (lunchStart > shiftStart && lunchEnd < shiftEnd) {
          workSegments.push({ start: shiftStart, end: lunchStart });
          workSegments.push({ start: lunchEnd, end: shiftEnd });
        } else {
          workSegments.push({ start: shiftStart, end: shiftEnd });
        }
      } else {
        // Lunch disabled: single continuous work segment!
        workSegments.push({ start: shiftStart, end: shiftEnd });
      }
    }
  }

  const standardFreeBlocks = extractFreeBlocks(workSegments);

  // Contiguous slot in standard / night shift hours
  for (const block of standardFreeBlocks) {
    const blockDuration = (block.end.getTime() - block.start.getTime()) / 60000;
    if (blockDuration >= durationNeeded) {
      const slotStart = new Date(block.start);
      const slotEnd = new Date(slotStart.getTime() + durationNeeded * 60000);

      const dayStr = formatIndonesianDate(slotStart, userTz);
      const timeStr = `${formatTime(slotStart, userTz)} - ${formatTime(slotEnd, userTz)}`;

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
          isNightShift,
        },
      };
    }
  }

  // Split sessions in standard / night shift hours
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
        explanation: `Kegiatan dipecah menjadi ${total} sesi realistis (total ${durationNeeded} menit). Sesi pertama dimulai ${formatIndonesianDate(new Date(first.startAt), userTz)}, pukul ${formatTime(new Date(first.startAt), userTz)} WIB.`,
        diagnostics: {
          isNightShift,
        },
      };
    }
  }

  // Phase C: Transparent Indonesian failure explanation
  const totalFreeAvailable = standardFreeBlocks.reduce(
    (acc, b) => acc + (b.end.getTime() - b.start.getTime()) / 60000,
    0
  );

  const deadlineInfo = deadline
    ? ` sebelum tenggat (${formatIndonesianDate(deadline, userTz)}, ${formatTime(deadline, userTz)})`
    : '';

  return {
    success: false,
    taskId: task.id,
    taskTitle: task.title,
    failureCode: 'NO_SLOT_BEFORE_DEADLINE',
    proposedSessions: [],
    explanation: `Tidak ditemukan slot waktu kosong yang mencukupi durasi (${durationNeeded} menit)${deadlineInfo}. Total waktu luang tersisa di jam kerja Anda hanya ${Math.round(totalFreeAvailable)} menit.`,
    warning: task.allowSplit
      ? 'Pertimbangkan untuk memperpanjang tenggat atau mengurangi durasi kegiatan.'
      : 'Saran: Anda dapat mengaktifkan opsi "Boleh dipecah menjadi beberapa sesi" atau menyesuaikan jam kerja di Pengaturan.',
    diagnostics: {
      freeTimeCalculatedMinutes: Math.round(totalFreeAvailable),
      isNightShift,
    },
  };
}

/**
 * Batch schedules multiple tasks deterministically by priority, hard constraints, and deadline.
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

  const sortedPending = [...pending].sort((a, b) => {
    const isFixedA = a.timeConstraintType === 'fixed_event' ? 100 : 0;
    const isFixedB = b.timeConstraintType === 'fixed_event' ? 100 : 0;
    if (isFixedB !== isFixedA) return isFixedB - isFixedA;

    const pA = priorityScore[a.priority] || 0;
    const pB = priorityScore[b.priority] || 0;
    if (pB !== pA) return pB - pA;

    const aTime = a.deadlineAt ? new Date(a.deadlineAt).getTime() : Infinity;
    const bTime = b.deadlineAt ? new Date(b.deadlineAt).getTime() : Infinity;
    return aTime - bTime;
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
