import type React from 'react';
import { Task, TaskScheduleSession, CalendarEvent } from '../types';
import { PushOperationTicket } from './calendarOperationGuard';
import {
  createGoogleCalendarEvent,
  GoogleCalendarApiError,
  classifyGoogleCalendarError,
  sanitizeSensitiveText,
  GoogleCalendarEventInput,
} from './googleCalendar';
import { persistScheduledTask } from './taskPersistence';

export interface ExecuteSchedulePushParams {
  token: string;
  task: Task;
  sessions: TaskScheduleSession[];
  timezone: string;
  userId: string | null;
  pushTicket: PushOperationTicket;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setEvents?: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
  createEventFn?: (
    accessToken: string,
    event: GoogleCalendarEventInput,
    signal?: AbortSignal
  ) => Promise<{ id: string; htmlLink?: string }>;
  saveToStorage?: (task: Task, userId: string) => Promise<void>;
  isTaskUpdate?: boolean;
  description?: string;
}

export interface SchedulePushResult {
  finalTask: Task;
  updatedSessions: TaskScheduleSession[];
  newCalendarEvents: CalendarEvent[];
  successCount: number;
  failCount: number;
  unconfirmedCount: number;
  reconciliationCount: number;
  hasEncounteredAuthError: boolean;
  wasAborted: boolean;
  isStale: boolean;
}

/**
 * Service orkestrasi pengiriman agenda ke Google Calendar.
 *
 * Menerapkan prinsip keandalan tingkat tinggi:
 * 1. Pencegahan duplikasi idempoten: Sesi yang sudah memiliki ID remote tidak dikirim ulang.
 * 2. Penanganan status ambigu: Error jaringan (NETWORK_ERROR), respons tidak valid (INVALID_RESPONSE),
 *    atau ID kosong dipetakan tegas ke 'needs_reconciliation', BUKAN 'failed' (yang rawan auto-retry buta)
 *    dan BUKAN 'synced' (karena ID remote belum terkonfirmasi).
 * 3. Larangan POST ulang otomatis: Sesi 'needs_reconciliation' dilewati dari pembuatan ulang.
 * 4. Pematuhan AbortSignal & pembatalan cepat.
 * 5. Persistensi lengkap ke state dan Firestore tanpa mengorbankan integritas data saat stale push.
 */
export async function executeSchedulePush(
  params: ExecuteSchedulePushParams
): Promise<SchedulePushResult> {
  const {
    token,
    task,
    sessions,
    timezone,
    userId,
    pushTicket,
    setTasks,
    setEvents,
    createEventFn = createGoogleCalendarEvent,
    saveToStorage,
    isTaskUpdate = true,
    description,
  } = params;

  let successCount = 0;
  let failCount = 0;
  let unconfirmedCount = 0;
  let reconciliationCount = 0;
  let hasEncounteredAuthError = false;
  let wasAborted = false;
  const updatedSessions: TaskScheduleSession[] = [];
  const newCalendarEvents: CalendarEvent[] = [];

  for (const sess of sessions) {
    if (pushTicket.isAborted()) {
      wasAborted = true;
      break;
    }

    const hasValidRemoteId =
      typeof sess.googleCalendarEventId === 'string' &&
      sess.googleCalendarEventId.trim().length > 0;

    // 1. Idempotensi: Sesi telah terkonfirmasi dibuat di Google Calendar
    if (sess.syncStatus === 'synced' && hasValidRemoteId) {
      updatedSessions.push(sess);
      continue;
    }

    // 2. Proteksi Status Ambigu: Sesi 'needs_reconciliation' DILARANG dikirim ulang via POST otomatis
    if (sess.syncStatus === 'needs_reconciliation' && !hasValidRemoteId) {
      reconciliationCount++;
      updatedSessions.push(sess);
      continue;
    }

    // 3. Anomali: Tercatat synced tapi tidak memiliki ID Google Calendar valid
    if (sess.syncStatus === 'synced' && !hasValidRemoteId) {
      unconfirmedCount++;
      reconciliationCount++;
      updatedSessions.push({
        ...sess,
        syncStatus: 'needs_reconciliation',
      });
      continue;
    }

    try {
      const eventDesc =
        description ||
        `Sesi ${sess.sessionIndex} dari ${sess.totalSessions} (${sess.durationMinutes} menit). Dijadwalkan otomatis oleh EVEN.`;

      const created = await createEventFn(
        token,
        {
          title: `[EVEN] ${sess.taskTitle}`,
          description: eventDesc,
          startAt: sess.startAt,
          endAt: sess.endAt,
          timezone,
          extendedProperties: {
            private: {
              evenTaskId: task.id,
              evenSessionId: sess.id,
              evenSessionIndex: String(sess.sessionIndex),
            },
          },
        },
        pushTicket.signal
      );

      const syncedSess: TaskScheduleSession = {
        ...sess,
        syncStatus: 'synced',
        googleCalendarEventId: created.id,
        htmlLink: created.htmlLink,
      };
      updatedSessions.push(syncedSess);

      newCalendarEvents.push({
        id: `gcal-${created.id}`,
        provider: 'google',
        title: `[EVEN] ${sess.taskTitle}`,
        description: eventDesc,
        startAt: sess.startAt,
        endAt: sess.endAt,
        htmlLink: created.htmlLink,
        isEditable: false,
        syncStatus: 'synced',
        category: 'focus',
        extendedProperties: {
          private: {
            evenTaskId: task.id,
            evenSessionId: sess.id,
            evenSessionIndex: String(sess.sessionIndex),
          },
        },
      });
      successCount++;
    } catch (err: any) {
      const classification =
        err instanceof GoogleCalendarApiError
          ? err.classification
          : classifyGoogleCalendarError(0, err.message || '', err);

      // Skenario A: Pembatalan eksplisit oleh pengguna
      if (pushTicket.isAborted() || classification.code === 'ABORTED') {
        wasAborted = true;
        updatedSessions.push({
          ...sess,
          syncStatus: 'pending',
        });
        break;
      }

      console.error('Schedule push error:', sanitizeSensitiveText(err.message || ''));

      // Skenario B: Kondisi Ambigu (NETWORK_ERROR, INVALID_RESPONSE, ID kosong)
      // Sisi server mungkin telah membuat event namun klien kehilangan ack respons.
      // Dilarang menandai sebagai 'failed' (yang dapat memicu retry POST buta).
      // Sesi dialihkan ke 'needs_reconciliation'.
      const isAmbiguous =
        classification.code === 'NETWORK_ERROR' ||
        classification.code === 'INVALID_RESPONSE' ||
        classification.code === 'NEEDS_RECONCILIATION' ||
        String(err.message || '').includes('tidak dapat dikonfirmasi');

      if (isAmbiguous) {
        unconfirmedCount++;
        reconciliationCount++;
        updatedSessions.push({
          ...sess,
          syncStatus: 'needs_reconciliation',
        });
      } else {
        // Skenario C: Kegagalan pasti di remote (HTTP 400, 401, 403, 404, 5xx)
        if (classification.isAuthError) {
          hasEncounteredAuthError = true;
        }
        failCount++;
        updatedSessions.push({
          ...sess,
          syncStatus: 'failed',
        });
      }
    }
  }

  // Jika dibatalkan di tengah proses, seluruh sesi tersisa dipertahankan sebagai 'pending'
  if (wasAborted && updatedSessions.length < sessions.length) {
    const processedCount = updatedSessions.length;
    for (let i = processedCount; i < sessions.length; i++) {
      updatedSessions.push({
        ...sessions[i],
        syncStatus: 'pending',
      });
    }
  }

  const finalTask: Task = {
    ...task,
    userId: userId || task.userId || 'user-default',
    status: 'SCHEDULED',
    scheduledSessions: updatedSessions,
  };

  // Persistensi data secara mutlak ke React state dan Firestore
  await persistScheduledTask({
    task: finalTask,
    userId,
    newCalendarEvents,
    setTasks,
    setEvents,
    isUpdate: isTaskUpdate,
    saveToStorage,
  });

  return {
    finalTask,
    updatedSessions,
    newCalendarEvents,
    successCount,
    failCount,
    unconfirmedCount,
    reconciliationCount,
    hasEncounteredAuthError,
    wasAborted,
    isStale: pushTicket.isStale(),
  };
}
