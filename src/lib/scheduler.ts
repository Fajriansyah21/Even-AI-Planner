import { Task, CalendarEvent, UserPreferences, ScheduleCalculationResult } from '../types';

interface TimeInterval {
  start: Date;
  end: Date;
}

/**
 * Deterministic Scheduler Engine for EVEN
 * Finds genuine, non-overlapping free slots within working hours before deadline.
 */
export function scheduleTaskDeterministically(
  task: Task,
  existingEvents: CalendarEvent[],
  existingTasks: Task[],
  preferences: UserPreferences,
  referenceDate: Date = new Date()
): ScheduleCalculationResult {
  const durationNeeded = task.estimatedDurationMinutes;
  const deadline = new Date(task.deadlineAt);

  if (isNaN(deadline.getTime())) {
    return {
      success: false,
      taskId: task.id,
      taskTitle: task.title,
      proposedSessions: [],
      explanation: 'Tenggat waktu (deadline) tidak valid atau belum diisi.'
    };
  }

  if (deadline.getTime() <= referenceDate.getTime()) {
    return {
      success: false,
      taskId: task.id,
      taskTitle: task.title,
      proposedSessions: [],
      explanation: `Tenggat waktu (${deadline.toLocaleDateString('id-ID', { hour: '2-digit', minute: '2-digit' })}) sudah lewat dari waktu saat ini.`
    };
  }

  // Collect all occupied busy windows
  const busyWindows: TimeInterval[] = [];

  // 1. From Calendar Events
  for (const event of existingEvents) {
    const s = new Date(event.startAt);
    const e = new Date(event.endAt);
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
      busyWindows.push({ start: s, end: e });
    }
  }

  // 2. From already scheduled task sessions (except this task's own sessions if rescheduling)
  for (const t of existingTasks) {
    if (t.id === task.id) continue;
    if (t.scheduledSessions && t.scheduledSessions.length > 0) {
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

  // Sort busy windows chronologically
  busyWindows.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Search window: starting from referenceDate up to deadline (max 14 days ahead)
  const maxSearchDays = 14;
  const candidateDays: Date[] = [];
  
  const searchStart = new Date(referenceDate);
  searchStart.setSeconds(0, 0);

  for (let d = 0; d < maxSearchDays; d++) {
    const day = new Date(searchStart);
    day.setDate(day.getDate() + d);
    day.setHours(0, 0, 0, 0);

    // Check if day is within allowed workDays
    const dayOfWeek = day.getDay(); // 0 is Sunday, 1 is Monday
    if (preferences.workDays.includes(dayOfWeek)) {
      candidateDays.push(day);
    }
  }

  // Find all free contiguous blocks within work hours
  const freeBlocks: TimeInterval[] = [];

  for (const day of candidateDays) {
    const workStart = new Date(day);
    workStart.setHours(preferences.workStartHour, 0, 0, 0);

    const workEnd = new Date(day);
    workEnd.setHours(preferences.workEndHour, 0, 0, 0);

    const lunchStart = new Date(day);
    lunchStart.setHours(preferences.lunchStartHour, 0, 0, 0);

    const lunchEnd = new Date(day);
    lunchEnd.setHours(preferences.lunchEndHour, 0, 0, 0);

    // Working segments for this day (morning and afternoon, excluding lunch)
    const dailySegments: TimeInterval[] = [
      { start: workStart, end: lunchStart },
      { start: lunchEnd, end: workEnd }
    ];

    for (const seg of dailySegments) {
      // Must be in the future
      let segStart = seg.start > searchStart ? seg.start : searchStart;
      let segEnd = seg.end < deadline ? seg.end : deadline;

      if (segStart >= segEnd) continue;

      // Subtract busy windows from this segment
      let currentPointer = new Date(segStart);

      // Find busy windows intersecting with this segment
      const overlappingBusy = busyWindows.filter(
        b => b.end > currentPointer && b.start < segEnd
      );

      for (const busy of overlappingBusy) {
        if (busy.start > currentPointer) {
          const potentialEnd = busy.start < segEnd ? busy.start : segEnd;
          // Apply buffer
          const freeDuration = (potentialEnd.getTime() - currentPointer.getTime()) / (1000 * 60);
          if (freeDuration >= 15) { // Minimum worthwhile slot is 15 minutes
            freeBlocks.push({
              start: new Date(currentPointer),
              end: new Date(potentialEnd)
            });
          }
        }
        if (busy.end > currentPointer) {
          // add buffer minutes after busy window
          const bufferedPointer = new Date(busy.end.getTime() + preferences.bufferMinutes * 60 * 1000);
          currentPointer = bufferedPointer > currentPointer ? bufferedPointer : currentPointer;
        }
      }

      if (currentPointer < segEnd) {
        const freeDuration = (segEnd.getTime() - currentPointer.getTime()) / (1000 * 60);
        if (freeDuration >= 15) {
          freeBlocks.push({
            start: new Date(currentPointer),
            end: new Date(segEnd)
          });
        }
      }
    }
  }

  // Strategy 1: Can we fit the whole task in one contiguous block?
  for (const block of freeBlocks) {
    const blockDuration = (block.end.getTime() - block.start.getTime()) / (1000 * 60);
    if (blockDuration >= durationNeeded) {
      // Round slot start to nearest clean 5 or 15 minutes
      const slotStart = new Date(block.start);
      // Align minutes to clean interval if desired
      const slotEnd = new Date(slotStart.getTime() + durationNeeded * 60 * 1000);

      const dayStr = slotStart.toLocaleDateString('id-ID', {
        weekday: 'long',
        day: 'numeric',
        month: 'short'
      });
      const timeStr = `${slotStart.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} - ${slotEnd.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;

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
            totalSessions: 1
          }
        ],
        explanation: `Ditemukan waktu fokus penuh ${durationNeeded} menit pada ${dayStr}, pukul ${timeStr}. Jadwal ini bebas konflik dan selesai sebelum tenggat.`
      };
    }
  }

  // Strategy 2: If task allows split sessions
  if (task.allowSplit) {
    const minSession = task.minimumSessionMinutes || 30;
    let remainingMinutes = durationNeeded;
    const splitSessions: {
      startAt: string;
      endAt: string;
      durationMinutes: number;
      sessionIndex: number;
      totalSessions: number;
    }[] = [];

    for (const block of freeBlocks) {
      if (remainingMinutes <= 0) break;

      const blockDuration = (block.end.getTime() - block.start.getTime()) / (1000 * 60);
      if (blockDuration < minSession) continue;

      const allocDuration = Math.min(blockDuration, remainingMinutes);
      // Ensure remaining isn't an awkward crumb smaller than minSession unless it's the last piece
      if (allocDuration < minSession) continue;

      const sessionStart = new Date(block.start);
      const sessionEnd = new Date(sessionStart.getTime() + allocDuration * 60 * 1000);

      splitSessions.push({
        startAt: sessionStart.toISOString(),
        endAt: sessionEnd.toISOString(),
        durationMinutes: allocDuration,
        sessionIndex: splitSessions.length + 1,
        totalSessions: 0 // Will fill after
      });

      remainingMinutes -= allocDuration;
    }

    if (remainingMinutes <= 0 && splitSessions.length > 0) {
      // Fill totalSessions
      const total = splitSessions.length;
      splitSessions.forEach(s => (s.totalSessions = total));

      const firstSession = splitSessions[0];
      const lastSession = splitSessions[splitSessions.length - 1];

      return {
        success: true,
        taskId: task.id,
        taskTitle: task.title,
        proposedSessions: splitSessions,
        explanation: `Tugas dipecah menjadi ${total} sesi realistis (total ${durationNeeded} menit) karena tidak ada blok kosong beruntun. Sesi pertama mulai ${new Date(firstSession.startAt).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.`
      };
    }
  }

  // Strategy 3: Failed to find valid slots
  const totalFreeAvailable = freeBlocks.reduce((acc, b) => acc + (b.end.getTime() - b.start.getTime()) / 60000, 0);

  return {
    success: false,
    taskId: task.id,
    taskTitle: task.title,
    proposedSessions: [],
    explanation: `Tidak ditemukan slot waktu kosong yang memenuhi durasi (${durationNeeded} menit) sebelum tenggat (${deadline.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}). Total waktu luang tersisa hanya ${Math.round(totalFreeAvailable)} menit.`,
    warning: task.allowSplit
      ? 'Pertimbangkan untuk memperpanjang tenggat atau memangkas durasi tugas.'
      : 'Saran: Anda dapat mengaktifkan opsi "Boleh dipecah menjadi beberapa sesi" atau memperpanjang tenggat waktu.'
  };
}

/**
 * Batch schedules multiple tasks by priority and deadline
 */
export function scheduleAllPendingTasks(
  tasks: Task[],
  existingEvents: CalendarEvent[],
  preferences: UserPreferences
): { results: ScheduleCalculationResult[]; updatedTasks: Task[] } {
  // Filter unscheduled tasks
  const pending = tasks.filter(t => t.status === 'UNSCHEDULED');
  
  // Sort by priority (URGENT > HIGH > MEDIUM > LOW) and earliest deadline
  const priorityScore: Record<string, number> = {
    URGENT: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1
  };

  const sortedPending = [...pending].sort((a, b) => {
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
      // Commit session to runningTasks so next tasks don't collide!
      const targetIndex = runningTasks.findIndex(item => item.id === t.id);
      if (targetIndex >= 0) {
        runningTasks[targetIndex] = {
          ...runningTasks[targetIndex],
          status: 'SCHEDULED',
          scheduledSessions: res.proposedSessions.map(s => ({
            id: `session-${t.id}-${s.sessionIndex}-${Date.now()}`,
            taskId: t.id,
            taskTitle: t.title,
            sessionIndex: s.sessionIndex,
            totalSessions: s.totalSessions,
            startAt: s.startAt,
            endAt: s.endAt,
            durationMinutes: s.durationMinutes,
            status: 'SCHEDULED',
            syncStatus: preferences.googleCalendarConnected ? 'synced' : 'pending'
          }))
        };
      }
    }
  }

  return { results, updatedTasks: runningTasks };
}
