import {
  Task,
  CalendarEvent,
  UserPreferences,
  ScheduleCalculationResult,
  DateEvaluationDiagnostic,
  OptimalSlotSuggestion,
} from '../types';
import {
  parseTimezoneString,
  getPartsInTimezone,
  createIsoInTimezone,
  formatInTimezone,
  addDaysInTimezone,
} from './timezone';
import { getNextValidDateForDayOfWeek, DAY_NAMES_ID } from './temporalParser';

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
 * Utilitas pemeriksaan zona waktu scheduler:
 * Memverifikasi dan menormalisasi referenceDate agar selalu merujuk pada zona waktu target
 * (Asia/Jakarta sebagai domain utama EVEN) sebelum memproses perhitungan jadwal,
 * guna menghindari kesalahan offset waktu atau pergeseran tanggal akibat lingkungan runner.
 */
export function verifyAndNormalizeReferenceDate(
  referenceDate: Date = new Date(),
  targetTimezone: string = 'Asia/Jakarta'
): {
  normalizedDate: Date;
  timezone: string;
  isJakartaTimezone: boolean;
  parts: ReturnType<typeof getPartsInTimezone>;
} {
  const tz = parseTimezoneString(targetTimezone || 'Asia/Jakarta');
  const isJakartaTimezone = tz === 'Asia/Jakarta' || tz.includes('Jakarta');

  // Ekstrak komponen tanggal dan jam secara presisi pada zona waktu target
  const parts = getPartsInTimezone(referenceDate, tz);

  // Rekonstruksi ISO absolut yang terikat langsung pada zona waktu target
  const iso = createIsoInTimezone(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    tz
  );

  return {
    normalizedDate: new Date(iso),
    timezone: tz,
    isJakartaTimezone,
    parts,
  };
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
  const { normalizedDate, timezone: userTz } = verifyAndNormalizeReferenceDate(
    referenceDate,
    task.timezone || preferences.timezone || 'Asia/Jakarta'
  );
  // Gunakan normalizedDate terverifikasi
  referenceDate = normalizedDate;

  // -------------------------------------------------------------
  // 1. HARD CONSTRAINT: MULTI-DAY FIXED COMMITMENTS (targetOccurrences or targetDays)
  // -------------------------------------------------------------
  let occurrencesToEvaluate = task.targetOccurrences;

  if (
    task.timeConstraintType === 'fixed_event' &&
    (!occurrencesToEvaluate || occurrencesToEvaluate.length === 0) &&
    task.targetDays &&
    task.targetDays.length > 0 &&
    task.requestedStartAt
  ) {
    const sDate = new Date(task.requestedStartAt);
    const sParts = getPartsInTimezone(sDate, userTz);
    const duration = task.requestedEndAt
      ? Math.round((new Date(task.requestedEndAt).getTime() - sDate.getTime()) / 60000)
      : durationNeeded;

    occurrencesToEvaluate = task.targetDays.map((dayOfWeek) => {
      const validDate = getNextValidDateForDayOfWeek(dayOfWeek, referenceDate, userTz, {
        targetHour: sParts.hour,
        targetMinute: sParts.minute,
      });
      const occStartIso = createIsoInTimezone(
        validDate.year,
        validDate.month,
        validDate.day,
        sParts.hour,
        sParts.minute,
        0,
        userTz
      );
      const occEndIso = new Date(new Date(occStartIso).getTime() + duration * 60000).toISOString();
      const dayName = DAY_NAMES_ID[dayOfWeek] || `Hari ${dayOfWeek}`;
      return {
        dayName,
        dayOfWeek,
        requestedStartAt: occStartIso,
        requestedEndAt: occEndIso,
        label: `${dayName} (${String(sParts.hour).padStart(2, '0')}:${String(sParts.minute).padStart(2, '0')})`,
      };
    });
  }

  if (
    task.timeConstraintType === 'fixed_event' &&
    occurrencesToEvaluate &&
    occurrencesToEvaluate.length > 0
  ) {
    const validSessions: ScheduleCalculationResult['proposedSessions'] = [];
    const failedOccurrences: { dayName: string; timeStr: string; reason: string }[] = [];

    for (let i = 0; i < occurrencesToEvaluate.length; i++) {
      const occ = occurrencesToEvaluate[i];
      const occStart = new Date(occ.requestedStartAt);
      const occEnd = new Date(occ.requestedEndAt);

      if (isNaN(occStart.getTime()) || isNaN(occEnd.getTime()) || occEnd <= occStart) {
        failedOccurrences.push({
          dayName: occ.dayName || `Kejadian ${i + 1}`,
          timeStr: 'Format waktu tidak valid',
          reason: 'Format tanggal atau waktu tidak valid.',
        });
        continue;
      }

      const occDuration = Math.round((occEnd.getTime() - occStart.getTime()) / 60000);
      const dayLabel = occ.dayName || formatIndonesianDate(occStart, userTz);
      const timeStr = `${formatTime(occStart, userTz)} - ${formatTime(occEnd, userTz)}`;

      // Check collision against calendar events
      let conflictReason: string | null = null;
      for (const evt of existingEvents) {
        const eStart = new Date(evt.startAt);
        const eEnd = new Date(evt.endAt);
        if (occStart < eEnd && occEnd > eStart) {
          conflictReason = `bertabrakan dengan acara kalender "${evt.title}" (${formatTime(eStart, userTz)} - ${formatTime(eEnd, userTz)})`;
          break;
        }
      }

      // Check collision against other scheduled tasks
      if (!conflictReason) {
        for (const t of existingTasks) {
          if (t.id === task.id) continue;
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
                if (occStart < sEnd && occEnd > sStart) {
                  conflictReason = `bertabrakan dengan kegiatan "${t.title}" sesi ${s.sessionIndex} (${formatTime(sStart, userTz)} - ${formatTime(sEnd, userTz)})`;
                  break;
                }
              }
            }
          }
          if (conflictReason) break;
        }
      }

      // Check collision against previously accepted sessions in this batch
      if (!conflictReason) {
        for (const prevSess of validSessions) {
          const pStart = new Date(prevSess.startAt);
          const pEnd = new Date(prevSess.endAt);
          if (occStart < pEnd && occEnd > pStart) {
            conflictReason = `bertabrakan dengan sesi ${prevSess.sessionIndex} dari kegiatan yang sama`;
            break;
          }
        }
      }

      if (conflictReason) {
        failedOccurrences.push({
          dayName: dayLabel,
          timeStr,
          reason: conflictReason,
        });
      } else {
        validSessions.push({
          startAt: occStart.toISOString(),
          endAt: occEnd.toISOString(),
          durationMinutes: occDuration,
          sessionIndex: validSessions.length + 1,
          totalSessions: 0,
          occurrenceLabel: dayLabel,
        });
      }
    }

    validSessions.forEach((s) => (s.totalSessions = validSessions.length));

    if (validSessions.length === occurrencesToEvaluate.length) {
      const occurrencesSummary = validSessions
        .map(
          (s) =>
            `${formatIndonesianDate(new Date(s.startAt), userTz)} (${formatTime(new Date(s.startAt), userTz)} - ${formatTime(new Date(s.endAt), userTz)} WIB)`
        )
        .join(', ');

      return {
        success: true,
        taskId: task.id,
        taskTitle: task.title,
        proposedSessions: validSessions,
        explanation: `Berhasil menjadwalkan ${validSessions.length} sesi terpisah sesuai permintaan: ${occurrencesSummary}. Setiap kejadian dijadwalkan secara presisi tanpa digeser.`,
      };
    } else if (validSessions.length > 0) {
      const successDays = validSessions
        .map(
          (s) =>
            `${formatIndonesianDate(new Date(s.startAt), userTz)} (${formatTime(new Date(s.startAt), userTz)} - ${formatTime(new Date(s.endAt), userTz)} WIB)`
        )
        .join(', ');
      const failedDetails = failedOccurrences
        .map((f) => `${f.dayName} (${f.timeStr}) karena ${f.reason}`)
        .join('; ');

      return {
        success: true,
        partialSuccess: true,
        taskId: task.id,
        taskTitle: task.title,
        proposedSessions: validSessions,
        explanation: `Sesi pada ${successDays} berhasil ditempatkan. Namun, kejadian pada ${failedDetails}. Sesuai prinsip keandalan jadwal, sesi yang bertabrakan tidak digeser diam-diam ke hari lain.`,
        warning: `Sebagian jadwal bertabrakan (${failedOccurrences.map((f) => f.dayName).join(', ')}). Hanya sesi yang bebas konflik yang dijadwalkan.`,
        skippedOccurrences: failedOccurrences.map((f) => ({
          dayName: f.dayName,
          reason: f.reason,
        })),
      };
    } else {
      return {
        success: false,
        taskId: task.id,
        taskTitle: task.title,
        failureCode: 'TIME_CONFLICT',
        proposedSessions: [],
        explanation: `Seluruh sesi waktu tetap yang diminta mengalami tabrakan jadwal:\n${failedOccurrences.map((f) => `• ${f.dayName} (${f.timeStr}): ${f.reason}`).join('\n')}. Komitmen waktu tetap tidak dapat digeser secara otomatis.`,
        warning: 'Silakan sesuaikan jam komitmen atau sesuaikan agenda yang bertabrakan di kalender.',
        skippedOccurrences: failedOccurrences.map((f) => ({
          dayName: f.dayName,
          reason: f.reason,
        })),
      };
    }
  }

  // -------------------------------------------------------------
  // 1B. SINGLE FIXED COMMITMENT (fixed_event)
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

  // Jika tugas memiliki target hari tunggal eksplisit (misal: "Kamis..."), targetkan hari tersebut!
  const hasSpecificSingleTargetDay = Boolean(
    task.targetDays && task.targetDays.length === 1 && !task.isRecurring
  );

  if (hasSpecificSingleTargetDay && task.targetDays) {
    const targetDayIndex = task.targetDays[0];
    const targetDateInfo = getNextValidDateForDayOfWeek(targetDayIndex, referenceDate, userTz);
    candidateDays.push({
      year: targetDateInfo.year,
      month: targetDateInfo.month,
      day: targetDateInfo.day,
      dayOfWeek: targetDayIndex,
      dateObj: targetDateInfo.date,
    });
  } else {
    for (let d = 0; d < maxSearchDays; d++) {
      const dayObj = addDaysInTimezone(searchStart, d, userTz);
      const parts = getPartsInTimezone(dayObj, userTz);
      const isPreferredWindowSpecified =
        Boolean(task.preferredWindow) || task.preferredTimeOfDay === 'EVENING' || task.preferredTimeOfDay === 'MORNING';

      const activeWorkDays = preferences.workDays || [1, 2, 3, 4, 5];
      if (activeWorkDays.includes(parts.dayOfWeek) || (isPreferredWindowSpecified && d <= 1)) {
        candidateDays.push({ ...parts, dateObj: dayObj });
      }
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

  // -------------------------------------------------------------
  // 2A. RECURRING / MULTI-DAY FLEXIBLE TASKS (targetDays)
  // -------------------------------------------------------------
  if (
    task.targetDays &&
    task.targetDays.length > 0 &&
    (task.isRecurring || task.targetDays.length > 1)
  ) {
    const validSessions: ScheduleCalculationResult['proposedSessions'] = [];
    const failedOccurrences: { dayName: string; timeStr: string; reason: string }[] = [];

    for (const dayOfWeek of task.targetDays) {
      const dayName = DAY_NAMES_ID[dayOfWeek] || `Hari ${dayOfWeek}`;
      const nextDate = getNextValidDateForDayOfWeek(dayOfWeek, referenceDate, userTz, {
        targetHour: preferredWindowStartHour ?? preferences.workStartHour ?? 9,
      });

      const daySegments: TimeInterval[] = [];
      if (preferredWindowStartHour !== null && preferredWindowEndHour !== null) {
        const pStartIso = createIsoInTimezone(
          nextDate.year,
          nextDate.month,
          nextDate.day,
          preferredWindowStartHour,
          task.preferredWindow?.startMinute || 0,
          0,
          userTz
        );
        const pEndIso = createIsoInTimezone(
          nextDate.year,
          nextDate.month,
          nextDate.day,
          preferredWindowEndHour,
          task.preferredWindow?.endMinute || 0,
          0,
          userTz
        );
        const pStart = new Date(pStartIso);
        const pEnd = new Date(pEndIso);
        if (pEnd > pStart) {
          daySegments.push({ start: pStart, end: pEnd });
        }
      } else {
        const wStartHour = preferences.workStartHour ?? 9;
        const wEndHour = preferences.workEndHour ?? 18;
        const wStartIso = createIsoInTimezone(nextDate.year, nextDate.month, nextDate.day, wStartHour, 0, 0, userTz);
        const wEndIso = createIsoInTimezone(nextDate.year, nextDate.month, nextDate.day, wEndHour, 0, 0, userTz);
        const wStart = new Date(wStartIso);
        const wEnd = new Date(wEndIso);
        if (wEnd > wStart) {
          daySegments.push({ start: wStart, end: wEnd });
        }
      }

      // Check free blocks specifically on this day, subtracting busyWindows AND sessions already added to this batch
      const combinedBusy: TimeInterval[] = [
        ...busyWindows,
        ...validSessions.map((s) => ({ start: new Date(s.startAt), end: new Date(s.endAt) })),
      ].sort((a, b) => a.start.getTime() - b.start.getTime());

      // Free blocks extractor for combinedBusy on daySegments
      const freeOnDay: TimeInterval[] = [];
      for (const seg of daySegments) {
        let currentPointer = new Date(seg.start);
        const overlappingBusy = combinedBusy.filter((b) => b.end > currentPointer && b.start < seg.end);
        for (const busy of overlappingBusy) {
          if (busy.start > currentPointer) {
            const potentialEnd = busy.start < seg.end ? busy.start : seg.end;
            const freeDuration = (potentialEnd.getTime() - currentPointer.getTime()) / 60000;
            if (freeDuration >= 15) {
              freeOnDay.push({ start: new Date(currentPointer), end: new Date(potentialEnd) });
            }
          }
          if (busy.end > currentPointer) {
            const bufferedPointer = new Date(busy.end.getTime() + preferences.bufferMinutes * 60 * 1000);
            currentPointer = bufferedPointer > currentPointer ? bufferedPointer : currentPointer;
          }
        }
        if (currentPointer < seg.end) {
          const freeDuration = (seg.end.getTime() - currentPointer.getTime()) / 60000;
          if (freeDuration >= 15) {
            freeOnDay.push({ start: new Date(currentPointer), end: new Date(seg.end) });
          }
        }
      }

      const windowDesc = task.preferredWindow?.label || (hasEveningPref ? 'malam' : 'jam kerja');

      // Check if day start is past deadline
      if (deadline) {
        const segCheckStart = (preferredWindowStartHour !== null)
          ? new Date(createIsoInTimezone(nextDate.year, nextDate.month, nextDate.day, preferredWindowStartHour, task.preferredWindow?.startMinute || 0, 0, userTz))
          : new Date(createIsoInTimezone(nextDate.year, nextDate.month, nextDate.day, preferences.workStartHour ?? 9, 0, 0, userTz));
        if (segCheckStart >= deadline) {
          failedOccurrences.push({
            dayName,
            timeStr: windowDesc,
            reason: `jadwal hari ${dayName} (${formatIndonesianDate(segCheckStart, userTz)}) berada setelah batas tenggat waktu (${formatIndonesianDate(deadline, userTz)}, ${formatTime(deadline, userTz)} WIB)`,
          });
          continue;
        }
      }

      // Find first slot of durationNeeded
      let allocatedSlot: { start: Date; end: Date } | null = null;
      for (const block of freeOnDay) {
        if (deadline && block.start >= deadline) continue;
        const effectiveEnd = deadline && block.end > deadline ? deadline : block.end;
        const blockDuration = (effectiveEnd.getTime() - block.start.getTime()) / 60000;
        if (blockDuration >= durationNeeded) {
          const slotStart = new Date(block.start);
          const slotEnd = new Date(slotStart.getTime() + durationNeeded * 60000);
          if (!deadline || slotEnd <= deadline) {
            allocatedSlot = { start: slotStart, end: slotEnd };
            break;
          }
        }
      }

      if (allocatedSlot) {
        validSessions.push({
          startAt: allocatedSlot.start.toISOString(),
          endAt: allocatedSlot.end.toISOString(),
          durationMinutes: durationNeeded,
          sessionIndex: validSessions.length + 1,
          totalSessions: 0,
          occurrenceLabel: `${dayName} (${formatTime(allocatedSlot.start, userTz)} - ${formatTime(allocatedSlot.end, userTz)})`,
        });
      } else {
        failedOccurrences.push({
          dayName,
          timeStr: windowDesc,
          reason: `slot waktu luang ${durationNeeded} menit tidak tersedia di jendela ${windowDesc} pada hari ${dayName}`,
        });
      }
    }

    validSessions.forEach((s) => (s.totalSessions = validSessions.length));

    if (validSessions.length === task.targetDays.length) {
      const summaryStr = validSessions
        .map(
          (s) =>
            `${formatIndonesianDate(new Date(s.startAt), userTz)} (${formatTime(new Date(s.startAt), userTz)} - ${formatTime(new Date(s.endAt), userTz)} WIB)`
        )
        .join(', ');
      return {
        success: true,
        taskId: task.id,
        taskTitle: task.title,
        proposedSessions: validSessions,
        explanation: `Berhasil menjadwalkan ${validSessions.length} sesi berulang sesuai target hari (${task.targetDays.map((d) => DAY_NAMES_ID[d]).join(', ')}): ${summaryStr}.`,
      };
    } else if (validSessions.length > 0) {
      const successStr = validSessions
        .map(
          (s) =>
            `${formatIndonesianDate(new Date(s.startAt), userTz)} (${formatTime(new Date(s.startAt), userTz)} - ${formatTime(new Date(s.endAt), userTz)} WIB)`
        )
        .join(', ');
      const failedStr = failedOccurrences.map((f) => `${f.dayName} (${f.reason})`).join('; ');
      return {
        success: true,
        partialSuccess: true,
        taskId: task.id,
        taskTitle: task.title,
        proposedSessions: validSessions,
        explanation: `Sesi berulang berhasil dijadwalkan pada ${successStr}. Namun, sesi pada ${failedStr}. Sesuai prinsip keandalan jadwal, sesi yang bertabrakan tidak digeser diam-diam ke hari lain.`,
        warning: `Sebagian jadwal berulang bertabrakan (${failedOccurrences.map((f) => f.dayName).join(', ')}). Hanya hari yang bebas konflik yang dijadwalkan.`,
        skippedOccurrences: failedOccurrences.map((f) => ({
          dayName: f.dayName,
          reason: f.reason,
        })),
      };
    } else {
      return {
        success: false,
        taskId: task.id,
        taskTitle: task.title,
        failureCode: 'TIME_CONFLICT',
        proposedSessions: [],
        explanation: `Semua hari target yang diminta (${task.targetDays.map((d) => DAY_NAMES_ID[d]).join(', ')}) penuh atau bertabrakan dengan kegiatan lain:\n${failedOccurrences.map((f) => `• ${f.dayName}: ${f.reason}`).join('\n')}.`,
        warning: 'Silakan sesuaikan jendela waktu atau kurangi agenda yang bertabrakan.',
        skippedOccurrences: failedOccurrences.map((f) => ({
          dayName: f.dayName,
          reason: f.reason,
        })),
      };
    }
  }

  // Phase A: Search within PREFERRED WINDOW first (if requested)
  if (preferredWindowStartHour !== null && preferredWindowEndHour !== null) {
    const preferredSegments: TimeInterval[] = [];
    const evaluatedDaysPreferred: DateEvaluationDiagnostic[] = [];

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

        // Collect diagnostics for this preferred day window
        const dayConflicts: string[] = [];
        for (const evt of existingEvents) {
          const eStart = new Date(evt.startAt);
          const eEnd = new Date(evt.endAt);
          if (pStart < eEnd && pEnd > eStart) {
            dayConflicts.push(`${evt.title} (${formatTime(eStart, userTz)} - ${formatTime(eEnd, userTz)} WIB)`);
          }
        }
        for (const t of existingTasks) {
          if (t.id === task.id) continue;
          if (t.status === 'completed_manual' || t.status === 'missed_auto' || t.status === 'COMPLETED') continue;
          if (t.scheduledSessions) {
            for (const s of t.scheduledSessions) {
              if (
                s.status !== 'CANCELLED' &&
                s.status !== 'completed_manual' &&
                s.status !== 'missed_auto' &&
                s.status !== 'COMPLETED'
              ) {
                const sStart = new Date(s.startAt);
                const sEnd = new Date(s.endAt);
                if (pStart < sEnd && pEnd > sStart) {
                  dayConflicts.push(
                    `${t.title} sesi ${s.sessionIndex} (${formatTime(sStart, userTz)} - ${formatTime(sEnd, userTz)} WIB)`
                  );
                }
              }
            }
          }
        }

        const dayFree = extractFreeBlocks([{ start: pStart, end: pEnd }]);
        const dayTotalFree = dayFree.reduce((sum, b) => sum + (b.end.getTime() - b.start.getTime()) / 60000, 0);
        let dayMax = 0;
        for (const b of dayFree) {
          const d = (b.end.getTime() - b.start.getTime()) / 60000;
          if (d > dayMax) dayMax = d;
        }

        evaluatedDaysPreferred.push({
          dateStr: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`,
          dayName: formatIndonesianDate(day.dateObj, userTz),
          windowStart: formatTime(pStart, userTz),
          windowEnd: formatTime(pEnd, userTz),
          totalFreeMinutes: Math.round(dayTotalFree),
          maxContiguousFreeMinutes: Math.round(dayMax),
          conflicts: dayConflicts,
          rejectionReason:
            dayTotalFree === 0
              ? 'Jendela waktu penuh oleh agenda lain'
              : `Slot bebas terbesar hanya ${Math.round(dayMax)} menit (dibutuhkan ${durationNeeded} menit tanpa opsi split)`,
        });
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
          diagnostics: {
            evaluatedDays: evaluatedDaysPreferred,
          },
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
          diagnostics: {
            evaluatedDays: evaluatedDaysPreferred,
          },
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
  const evaluatedDaysWork: DateEvaluationDiagnostic[] = [];

  for (const day of candidateDays) {
    const daySegments: TimeInterval[] = [];

    if (isNightShift) {
      // Night shift crossing midnight: starts on `day` at workStartHour, ends on `day + 1` at workEndHour
      const shiftStartIso = createIsoInTimezone(day.year, day.month, day.day, workStartHour, 0, 0, userTz);
      const nextDayDate = addDaysInTimezone(day.dateObj, 1, userTz);
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
          daySegments.push({ start: shiftStart, end: lunchStart });
          daySegments.push({ start: lunchEnd, end: shiftEnd });
        } else {
          daySegments.push({ start: shiftStart, end: shiftEnd });
        }
      } else {
        daySegments.push({ start: shiftStart, end: shiftEnd });
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
          daySegments.push({ start: shiftStart, end: lunchStart });
          daySegments.push({ start: lunchEnd, end: shiftEnd });
        } else {
          daySegments.push({ start: shiftStart, end: shiftEnd });
        }
      } else {
        // Lunch disabled: single continuous work segment!
        daySegments.push({ start: shiftStart, end: shiftEnd });
      }
    }

    for (const seg of daySegments) {
      workSegments.push(seg);
    }

    const dayStart = daySegments[0]?.start;
    const dayEnd = daySegments[daySegments.length - 1]?.end;
    if (dayStart && dayEnd) {
      const conflicts: string[] = [];
      for (const evt of existingEvents) {
        const eStart = new Date(evt.startAt);
        const eEnd = new Date(evt.endAt);
        if (dayStart < eEnd && dayEnd > eStart) {
          conflicts.push(`${evt.title} (${formatTime(eStart, userTz)} - ${formatTime(eEnd, userTz)} WIB)`);
        }
      }
      for (const t of existingTasks) {
        if (t.id === task.id) continue;
        if (t.status === 'completed_manual' || t.status === 'missed_auto' || t.status === 'COMPLETED') continue;
        if (t.scheduledSessions) {
          for (const s of t.scheduledSessions) {
            if (
              s.status !== 'CANCELLED' &&
              s.status !== 'completed_manual' &&
              s.status !== 'missed_auto' &&
              s.status !== 'COMPLETED'
            ) {
              const sStart = new Date(s.startAt);
              const sEnd = new Date(s.endAt);
              if (dayStart < sEnd && dayEnd > sStart) {
                conflicts.push(
                  `${t.title} sesi ${s.sessionIndex} (${formatTime(sStart, userTz)} - ${formatTime(sEnd, userTz)} WIB)`
                );
              }
            }
          }
        }
      }

      const dayFree = extractFreeBlocks(daySegments);
      const dayTotalFree = dayFree.reduce((sum, b) => sum + (b.end.getTime() - b.start.getTime()) / 60000, 0);
      let dayMax = 0;
      for (const b of dayFree) {
        const d = (b.end.getTime() - b.start.getTime()) / 60000;
        if (d > dayMax) dayMax = d;
      }

      evaluatedDaysWork.push({
        dateStr: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`,
        dayName: formatIndonesianDate(day.dateObj, userTz),
        windowStart: formatTime(dayStart, userTz),
        windowEnd: formatTime(dayEnd, userTz),
        totalFreeMinutes: Math.round(dayTotalFree),
        maxContiguousFreeMinutes: Math.round(dayMax),
        conflicts,
        rejectionReason:
          dayTotalFree === 0
            ? 'Jendela jam kerja penuh oleh agenda lain'
            : `Slot bebas terbesar hanya ${Math.round(dayMax)} menit (dibutuhkan ${durationNeeded} menit tanpa opsi split)`,
      });
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
          evaluatedDays: evaluatedDaysWork,
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
          evaluatedDays: evaluatedDaysWork,
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

  const diagSummary = evaluatedDaysWork
    .map(
      (ed) =>
        `• ${ed.dayName} (${ed.windowStart} - ${ed.windowEnd} WIB): Total luang ${ed.totalFreeMinutes} menit${
          ed.maxContiguousFreeMinutes !== undefined ? `, slot bebas terpanjang ${ed.maxContiguousFreeMinutes} menit` : ''
        }.${ed.conflicts.length > 0 ? ` Terhalang: ${ed.conflicts.join(', ')}.` : ' Tidak ada konflik agenda.'} Alasan: ${ed.rejectionReason}`
    )
    .join('\n');

  return {
    success: false,
    taskId: task.id,
    taskTitle: task.title,
    failureCode: 'NO_SLOT_BEFORE_DEADLINE',
    proposedSessions: [],
    explanation: `Tidak ditemukan slot waktu kosong yang mencukupi durasi (${durationNeeded} menit)${deadlineInfo}. Total waktu luang tersisa di jam kerja Anda hanya ${Math.round(totalFreeAvailable)} menit.${
      diagSummary ? `\n\nDiagnostik evaluasi slot per tanggal:\n${diagSummary}` : ''
    }`,
    warning: task.allowSplit
      ? 'Pertimbangkan untuk memperpanjang tenggat atau mengurangi durasi kegiatan.'
      : 'Saran: Anda dapat mengaktifkan opsi "Boleh dipecah menjadi beberapa sesi" atau menyesuaikan jam kerja di Pengaturan.',
    diagnostics: {
      freeTimeCalculatedMinutes: Math.round(totalFreeAvailable),
      isNightShift,
      evaluatedDays: evaluatedDaysWork,
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

/**
 * Memberikan saran slot waktu berdasarkan analisis historis produktivitas pengguna,
 * di luar sekadar mencari slot kosong pertama.
 *
 * Menggabungkan:
 * 1. Analisis riwayat tugas selesai vs terlewat (pagi/siang/malam & hari terbaik)
 * 2. Keselarasan prioritas tugas (tugas HIGH/URGENT diarahkan ke jendela produktivitas puncak)
 * 3. Kualitas slot: durasi blok tanpa gangguan, buffer sehat, jarak ideal dari tenggat
 */
export function suggestOptimalSlot(
  task: Task,
  existingEvents: CalendarEvent[],
  existingTasks: Task[],
  preferences: UserPreferences,
  referenceDate: Date = new Date()
): OptimalSlotSuggestion {
  const durationNeeded = task.estimatedDurationMinutes || 60;
  const { normalizedDate, timezone: userTz } = verifyAndNormalizeReferenceDate(
    referenceDate,
    task.timezone || preferences.timezone || 'Asia/Jakarta'
  );
  referenceDate = normalizedDate;

  // 1. Analisis riwayat produktivitas pengguna
  const windowStats = {
    MORNING: { completed: 0, missed: 0 },
    AFTERNOON: { completed: 0, missed: 0 },
    EVENING: { completed: 0, missed: 0 },
  };

  const dayOfWeekStats: Record<number, { completed: number; missed: number }> = {
    0: { completed: 0, missed: 0 },
    1: { completed: 0, missed: 0 },
    2: { completed: 0, missed: 0 },
    3: { completed: 0, missed: 0 },
    4: { completed: 0, missed: 0 },
    5: { completed: 0, missed: 0 },
    6: { completed: 0, missed: 0 },
  };

  let totalCompleted = 0;
  let totalMissed = 0;

  for (const t of existingTasks) {
    if (t.status === 'completed_manual' || t.status === 'COMPLETED' || t.completedAt) {
      totalCompleted++;
      const dateToCheck = t.completedAt
        ? new Date(t.completedAt)
        : t.scheduledSessions && t.scheduledSessions[0]
        ? new Date(t.scheduledSessions[0].startAt)
        : null;
      if (dateToCheck && !isNaN(dateToCheck.getTime())) {
        const parts = getPartsInTimezone(dateToCheck, userTz);
        if (parts.hour >= 6 && parts.hour < 12) windowStats.MORNING.completed++;
        else if (parts.hour >= 12 && parts.hour < 18) windowStats.AFTERNOON.completed++;
        else windowStats.EVENING.completed++;

        if (dayOfWeekStats[parts.dayOfWeek]) {
          dayOfWeekStats[parts.dayOfWeek].completed++;
        }
      }
    } else if (t.status === 'missed_auto' || t.missedAt) {
      totalMissed++;
      const dateToCheck = t.missedAt
        ? new Date(t.missedAt)
        : t.scheduledSessions && t.scheduledSessions[0]
        ? new Date(t.scheduledSessions[0].startAt)
        : null;
      if (dateToCheck && !isNaN(dateToCheck.getTime())) {
        const parts = getPartsInTimezone(dateToCheck, userTz);
        if (parts.hour >= 6 && parts.hour < 12) windowStats.MORNING.missed++;
        else if (parts.hour >= 12 && parts.hour < 18) windowStats.AFTERNOON.missed++;
        else windowStats.EVENING.missed++;

        if (dayOfWeekStats[parts.dayOfWeek]) {
          dayOfWeekStats[parts.dayOfWeek].missed++;
        }
      }
    }
  }

  // Hitung persentase keberhasilan per jendela
  const calcRate = (c: number, m: number) => {
    const total = c + m;
    return total > 0 ? Math.round((c / total) * 100) : 0;
  };

  const morningRate = calcRate(windowStats.MORNING.completed, windowStats.MORNING.missed);
  const afternoonRate = calcRate(windowStats.AFTERNOON.completed, windowStats.AFTERNOON.missed);
  const eveningRate = calcRate(windowStats.EVENING.completed, windowStats.EVENING.missed);

  // Tentukan jendela produktivitas puncak
  let peakProductivityWindow: 'MORNING' | 'AFTERNOON' | 'EVENING' = 'MORNING';
  let bestRate = morningRate;

  if (totalCompleted >= 2) {
    if (afternoonRate > bestRate && windowStats.AFTERNOON.completed > 0) {
      peakProductivityWindow = 'AFTERNOON';
      bestRate = afternoonRate;
    }
    if (eveningRate > bestRate && windowStats.EVENING.completed > 0) {
      peakProductivityWindow = 'EVENING';
      bestRate = eveningRate;
    }
  } else {
    // Default standar sains fokus kerja mendalam
    bestRate = 85;
  }

  // Tentukan hari produktif terbaik
  let bestDayIndex = 2; // Selasa default
  let maxDayCompleted = -1;
  for (let d = 1; d <= 5; d++) {
    if (dayOfWeekStats[d].completed > maxDayCompleted) {
      maxDayCompleted = dayOfWeekStats[d].completed;
      bestDayIndex = d;
    }
  }
  const bestDayOfWeek = DAY_NAMES_ID[bestDayIndex] || 'Selasa';

  // 2. Kumpulkan slot kosong yang tersedia
  const baseResult = scheduleTaskDeterministically(
    task,
    existingEvents,
    existingTasks,
    preferences,
    referenceDate
  );

  if (!baseResult.success || baseResult.proposedSessions.length === 0) {
    return {
      success: false,
      taskId: task.id,
      taskTitle: task.title,
      productivityScore: 0,
      historicalAnalysis: {
        peakProductivityWindow,
        completionRateInWindow: bestRate,
        bestDayOfWeek,
        totalCompletedAnalyzed: totalCompleted,
        totalMissedAnalyzed: totalMissed,
      },
      reasoning: `Tidak dapat memberikan rekomendasi optimal karena tidak ada slot kosong yang tersedia: ${baseResult.explanation}`,
    };
  }

  // 3. Skor kandidat slot berdasarkan kecocokan produktivitas
  const candidateSlots = baseResult.proposedSessions.map((sess) => {
    const sStart = new Date(sess.startAt);
    const parts = getPartsInTimezone(sStart, userTz);
    let score = 55; // baseline

    let slotWindow: 'MORNING' | 'AFTERNOON' | 'EVENING' = 'MORNING';
    if (parts.hour >= 6 && parts.hour < 12) slotWindow = 'MORNING';
    else if (parts.hour >= 12 && parts.hour < 18) slotWindow = 'AFTERNOON';
    else slotWindow = 'EVENING';

    if (slotWindow === peakProductivityWindow) {
      score += 25;
    } else if (slotWindow === 'MORNING') {
      score += 15;
    }

    if (task.priority === 'HIGH' || task.priority === 'URGENT') {
      if (slotWindow === 'MORNING' || slotWindow === peakProductivityWindow) {
        score += 15;
      }
    } else {
      score += 10;
    }

    if (parts.dayOfWeek === bestDayIndex) {
      score += 10;
    } else if (parts.dayOfWeek >= 1 && parts.dayOfWeek <= 4) {
      score += 5;
    }

    score = Math.min(100, Math.max(10, score));

    const dayName = formatIndonesianDate(sStart, userTz);
    const timeRangeStr = `${formatTime(sStart, userTz)} - ${formatTime(new Date(sess.endAt), userTz)} WIB`;

    return {
      startAt: sess.startAt,
      endAt: sess.endAt,
      durationMinutes: sess.durationMinutes,
      dayName,
      timeRangeStr,
      score,
      label: `${dayName}, ${timeRangeStr} (Skor Produktivitas: ${score}%)`,
    };
  });

  candidateSlots.sort((a, b) => b.score - a.score);
  const bestSlot = candidateSlots[0];
  const alternatives = candidateSlots.slice(1);

  const windowLabel =
    peakProductivityWindow === 'MORNING'
      ? 'Pagi (09:00 - 12:00)'
      : peakProductivityWindow === 'AFTERNOON'
      ? 'Siang/Sore (13:00 - 17:00)'
      : 'Malam (19:00 - 22:00)';

  let reasoning = '';
  if (totalCompleted >= 3) {
    reasoning = `Berdasarkan analisis riwayat ${totalCompleted} tugas selesai Anda, jendela ${windowLabel} memiliki tingkat keberhasilan tertinggi (${bestRate}%), dengan performa optimal pada hari ${bestDayOfWeek}. Slot ${bestSlot.dayName} pukul ${bestSlot.timeRangeStr} direkomendasikan dengan skor produktivitas ${bestSlot.score}%.`;
  } else {
    reasoning = `Berdasarkan standar fokus kognitif dan jam kerja produktif, jendela ${windowLabel} memberikan konsentrasi tertinggi bebas interupsi. Slot ${bestSlot.dayName} pukul ${bestSlot.timeRangeStr} direkomendasikan dengan skor produktivitas ${bestSlot.score}%.`;
  }

  return {
    success: true,
    taskId: task.id,
    taskTitle: task.title,
    recommendedSlot: {
      startAt: bestSlot.startAt,
      endAt: bestSlot.endAt,
      durationMinutes: bestSlot.durationMinutes,
      dayName: bestSlot.dayName,
      timeRangeStr: bestSlot.timeRangeStr,
    },
    productivityScore: bestSlot.score,
    historicalAnalysis: {
      peakProductivityWindow,
      completionRateInWindow: bestRate,
      bestDayOfWeek,
      totalCompletedAnalyzed: totalCompleted,
      totalMissedAnalyzed: totalMissed,
    },
    reasoning,
    alternativeSlots: alternatives.map((a) => ({
      startAt: a.startAt,
      endAt: a.endAt,
      durationMinutes: a.durationMinutes,
      score: a.score,
      label: a.label,
    })),
  };
}

export { addDaysInTimezone };
