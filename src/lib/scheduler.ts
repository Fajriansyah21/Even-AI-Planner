import { Task, CalendarEvent, UserPreferences, ScheduleCalculationResult } from '../types';

interface TimeInterval {
  start: Date;
  end: Date;
}

function formatIndonesianDate(d: Date): string {
  return d.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Deterministic Scheduler Engine for EVEN
 * Strictly respects:
 * 1. Fixed events: Cannot be shifted; placed precisely at requestedStartAt - requestedEndAt; checks collisions.
 * 2. Preferred time windows: Evening (19:00-23:00) or user-specified windows outside or inside standard work hours.
 * 3. Never confuses night (e.g. 21:00) with morning (09:00).
 * 4. Deterministic non-overlapping slot allocation with buffers and split session support.
 */
export function scheduleTaskDeterministically(
  task: Task,
  existingEvents: CalendarEvent[],
  existingTasks: Task[],
  preferences: UserPreferences,
  referenceDate: Date = new Date()
): ScheduleCalculationResult {
  const durationNeeded = task.estimatedDurationMinutes || 60;
  
  // -------------------------------------------------------------
  // 1. HARD CONSTRAINT: FIXED COMMITMENT (fixed_event)
  // -------------------------------------------------------------
  const isFixedEvent =
    task.timeConstraintType === 'fixed_event' ||
    (Boolean(task.requestedStartAt) && Boolean(task.requestedEndAt));

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
          explanation: `Konflik jadwal: Komitmen tetap (${formatTime(fixedStart)} - ${formatTime(fixedEnd)}) bertabrakan dengan acara kalender "${evt.title}" (${formatTime(eStart)} - ${formatTime(eEnd)}). Komitmen waktu tetap tidak dapat digeser secara otomatis.`,
          warning: 'Silakan sesuaikan jam komitmen atau pindahkan acara yang bertabrakan di Google Calendar.',
        };
      }
    }

    // Check collision against other scheduled task sessions
    for (const t of existingTasks) {
      if (t.id === task.id) continue;
      if (t.scheduledSessions && t.scheduledSessions.length > 0) {
        for (const s of t.scheduledSessions) {
          if (s.status !== 'CANCELLED') {
            const sStart = new Date(s.startAt);
            const sEnd = new Date(s.endAt);
            if (fixedStart < sEnd && fixedEnd > sStart) {
              return {
                success: false,
                taskId: task.id,
                taskTitle: task.title,
                proposedSessions: [],
                explanation: `Konflik jadwal: Komitmen tetap bertabrakan dengan tugas "${t.title}" sesi ${s.sessionIndex} (${formatTime(sStart)} - ${formatTime(sEnd)}).`,
                warning: 'Jadwal waktu tetap memerlukan slot kosong tanpa tabrakan tugas lain.',
              };
            }
          }
        }
      }
    }

    // No collision found! Place fixed event precisely
    const fixedDuration = Math.round((fixedEnd.getTime() - fixedStart.getTime()) / 60000);
    const dayStr = formatIndonesianDate(fixedStart);
    const timeStr = `${formatTime(fixedStart)} - ${formatTime(fixedEnd)}`;

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
  let deadline = new Date(task.deadlineAt);
  if (isNaN(deadline.getTime())) {
    // If deadline is invalid, default to 3 days ahead at 23:59
    deadline = new Date(referenceDate);
    deadline.setDate(deadline.getDate() + 3);
    deadline.setHours(23, 59, 59, 999);
  }

  if (deadline.getTime() <= referenceDate.getTime()) {
    return {
      success: false,
      taskId: task.id,
      taskTitle: task.title,
      proposedSessions: [],
      explanation: `Tenggat waktu (${formatIndonesianDate(deadline)}, ${formatTime(deadline)}) sudah lewat dari waktu saat ini.`,
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

  // Build candidate days from referenceDate up to deadline (max 14 days)
  const maxSearchDays = 14;
  const candidateDays: Date[] = [];
  const searchStart = new Date(referenceDate);
  searchStart.setSeconds(0, 0);

  for (let d = 0; d < maxSearchDays; d++) {
    const day = new Date(searchStart);
    day.setDate(day.getDate() + d);
    day.setHours(0, 0, 0, 0);

    const dayOfWeek = day.getDay();
    // Allow weekends if user requested specific preferred window or if today is weekend
    const isPreferredWindowSpecified =
      Boolean(task.preferredWindow) || task.preferredTimeOfDay === 'EVENING';

    if (preferences.workDays.includes(dayOfWeek) || (isPreferredWindowSpecified && d === 0)) {
      candidateDays.push(day);
    }
  }

  // Determine user preferred time window (if any)
  // CRITICAL: If task mentions evening / malam (e.g. 19:00 - 23:00), never restrict it to 09:00-18:00!
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

  // Helper to subtract busy windows from an interval
  const extractFreeBlocks = (segments: TimeInterval[]): TimeInterval[] => {
    const free: TimeInterval[] = [];

    for (const seg of segments) {
      const segStart = seg.start > searchStart ? seg.start : searchStart;
      const segEnd = seg.end < deadline ? seg.end : deadline;

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
      const pStart = new Date(day);
      pStart.setHours(preferredWindowStartHour, task.preferredWindow?.startMinute || 0, 0, 0);

      const pEnd = new Date(day);
      pEnd.setHours(preferredWindowEndHour, task.preferredWindow?.endMinute || 0, 0, 0);

      if (pEnd > pStart) {
        preferredSegments.push({ start: pStart, end: pEnd });
      }
    }

    const preferredFreeBlocks = extractFreeBlocks(preferredSegments);

    // Try contiguous fit in preferred window
    for (const block of preferredFreeBlocks) {
      const blockDuration = (block.end.getTime() - block.start.getTime()) / 60000;
      if (blockDuration >= durationNeeded) {
        const slotStart = new Date(block.start);
        const slotEnd = new Date(slotStart.getTime() + durationNeeded * 60000);

        const dayStr = formatIndonesianDate(slotStart);
        const timeStr = `${formatTime(slotStart)} - ${formatTime(slotEnd)}`;
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
          explanation: `Tugas dipecah menjadi ${total} sesi realistis di jendela waktu ${task.preferredWindow?.label || 'malam'} yang diminta. Sesi pertama mulai ${formatIndonesianDate(new Date(first.startAt))}, pukul ${formatTime(new Date(first.startAt))} WIB.`,
        };
      }
    }
  }

  // Phase B: Standard Work Hours Search
  // (09:00 - 18:00, excluding lunch)
  const standardSegments: TimeInterval[] = [];

  for (const day of candidateDays) {
    const workStart = new Date(day);
    workStart.setHours(preferences.workStartHour, 0, 0, 0);

    const workEnd = new Date(day);
    workEnd.setHours(preferences.workEndHour, 0, 0, 0);

    const lunchStart = new Date(day);
    lunchStart.setHours(preferences.lunchStartHour, 0, 0, 0);

    const lunchEnd = new Date(day);
    lunchEnd.setHours(preferences.lunchEndHour, 0, 0, 0);

    standardSegments.push({ start: workStart, end: lunchStart });
    standardSegments.push({ start: lunchEnd, end: workEnd });
  }

  const standardFreeBlocks = extractFreeBlocks(standardSegments);

  // Contiguous slot in standard hours
  for (const block of standardFreeBlocks) {
    const blockDuration = (block.end.getTime() - block.start.getTime()) / 60000;
    if (blockDuration >= durationNeeded) {
      const slotStart = new Date(block.start);
      const slotEnd = new Date(slotStart.getTime() + durationNeeded * 60000);

      const dayStr = formatIndonesianDate(slotStart);
      const timeStr = `${formatTime(slotStart)} - ${formatTime(slotEnd)}`;

      const fallbackNote =
        preferredWindowStartHour !== null
          ? ' (Catatan: Jendela waktu malam/khusus yang diminta penuh atau tidak mencukupi, sehingga dialihkan ke jam kerja produktif terdekat).'
          : '';

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
        explanation: `Ditemukan waktu fokus penuh ${durationNeeded} menit pada ${dayStr}, pukul ${timeStr} WIB.${fallbackNote}`,
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
        explanation: `Tugas dipecah menjadi ${total} sesi realistis (total ${durationNeeded} menit). Sesi pertama dimulai ${formatIndonesianDate(new Date(first.startAt))}, pukul ${formatTime(new Date(first.startAt))} WIB.`,
      };
    }
  }

  // Phase C: If all fail, return transparent Indonesian failure explanation
  const totalFreeAvailable = standardFreeBlocks.reduce(
    (acc, b) => acc + (b.end.getTime() - b.start.getTime()) / 60000,
    0
  );

  return {
    success: false,
    taskId: task.id,
    taskTitle: task.title,
    proposedSessions: [],
    explanation: `Tidak ditemukan slot waktu kosong yang mencukupi durasi (${durationNeeded} menit) sebelum tenggat (${formatIndonesianDate(deadline)}, ${formatTime(deadline)}). Total waktu luang tersisa di kalender Anda hanya ${Math.round(totalFreeAvailable)} menit.`,
    warning: task.allowSplit
      ? 'Pertimbangkan untuk memperpanjang tenggat atau mengurangi durasi tugas.'
      : 'Saran: Anda dapat mengaktifkan opsi "Boleh dipecah menjadi beberapa sesi" atau memperpanjang tenggat waktu.',
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

    return new Date(a.deadlineAt).getTime() - new Date(b.deadlineAt).getTime();
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
