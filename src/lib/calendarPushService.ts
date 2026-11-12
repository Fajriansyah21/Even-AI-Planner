import type React from 'react';
import { Task, TaskScheduleSession, CalendarEvent } from '../types';
import { PushOperationTicket, SyncOperationTicket, CalendarOperationGuard } from './calendarOperationGuard';
import {
  createGoogleCalendarEvent,
  fetchGoogleCalendarEvents,
  reconcileSessionWithRemoteEvents,
  GoogleCalendarApiError,
  classifyGoogleCalendarError,
  sanitizeSensitiveText,
  GoogleCalendarEventInput,
  deleteGoogleCalendarEvent,
} from './googleCalendar';
import { persistScheduledTask } from './taskPersistence';
import {
  isSessionDeleted,
  recordSessionDeletionDurable,
  compensateRemoteDeletion,
} from './deletionTombstone';

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
  deleteEventFn?: (
    accessToken: string,
    googleEventId: string,
    signal?: AbortSignal
  ) => Promise<void>;
  cleanupClaimFn?: Parameters<typeof compensateRemoteDeletion>[0]['claimCleanupFn'];
  cleanupSyncStateFn?: Parameters<typeof compensateRemoteDeletion>[0]['syncStateFn'];
  saveToStorage?: (task: Task, userId: string) => Promise<void>;
  isTaskUpdate?: boolean;
  description?: string;
  guard?: CalendarOperationGuard;
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
    guard: explicitGuard,
  } = params;

  const guard = explicitGuard || pushTicket.guard;

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

    // 0. User Deletion Intent Wins (Skenario A):
    // Jika sesi ini telah dihapus oleh pengguna sebelum POST dikirim, BATALKAN POST
    if (isSessionDeleted(userId, task.id, sess.id)) {
      guard?.clearSessionState(sess.id, task.id, userId || 'user-default');
      continue;
    }

    const hasValidRemoteId =
      typeof sess.googleCalendarEventId === 'string' &&
      sess.googleCalendarEventId.trim().length > 0;

    // 1. Idempotensi: Sesi telah terkonfirmasi dibuat di Google Calendar
    if (sess.syncStatus === 'synced' && hasValidRemoteId) {
      updatedSessions.push(sess);
      continue;
    }

    // 2. Proteksi Concurrency Sesi yang Sama:
    // Jika guard telah mencatat remote ID untuk sesi ini (dari operasi lain atau concurrent push)
    const inFlightRecord = guard?.getInFlightSession(sess.id, task.id, userId || 'user-default');
    if (inFlightRecord?.remoteId) {
      const syncedSess: TaskScheduleSession = {
        ...sess,
        syncStatus: 'synced',
        googleCalendarEventId: inFlightRecord.remoteId,
        htmlLink: inFlightRecord.htmlLink || sess.htmlLink,
      };
      updatedSessions.push(syncedSess);
      newCalendarEvents.push({
        id: `gcal-${inFlightRecord.remoteId}`,
        provider: 'google',
        title: `[EVEN] ${sess.taskTitle}`,
        description:
          description ||
          `Sesi ${sess.sessionIndex} dari ${sess.totalSessions} (${sess.durationMinutes} menit). Dijadwalkan otomatis oleh EVEN.`,
        startAt: sess.startAt,
        endAt: sess.endAt,
        htmlLink: inFlightRecord.htmlLink,
        isEditable: false,
        syncStatus: 'synced',
        category: 'focus',
      });
      successCount++;
      continue;
    }

    // 3. Jika sesi ini sedang diproses secara aktif oleh push lain dan memiliki promise in-flight:
    // Tunggu promise tersebut untuk mencegah pembuatan event ganda di server (Same-Session Concurrency Protection)
    if (inFlightRecord?.promise && inFlightRecord.pushId !== pushTicket.pushId) {
      try {
        const remoteResult = await inFlightRecord.promise;
        if (remoteResult && remoteResult.id) {
          const syncedSess: TaskScheduleSession = {
            ...sess,
            syncStatus: 'synced',
            googleCalendarEventId: remoteResult.id,
            htmlLink: remoteResult.htmlLink || sess.htmlLink,
          };
          updatedSessions.push(syncedSess);
          newCalendarEvents.push({
            id: `gcal-${remoteResult.id}`,
            provider: 'google',
            title: `[EVEN] ${sess.taskTitle}`,
            description:
              description ||
              `Sesi ${sess.sessionIndex} dari ${sess.totalSessions} (${sess.durationMinutes} menit). Dijadwalkan otomatis oleh EVEN.`,
            startAt: sess.startAt,
            endAt: sess.endAt,
            htmlLink: remoteResult.htmlLink,
            isEditable: false,
            syncStatus: 'synced',
            category: 'focus',
          });
          successCount++;
          continue;
        }
      } catch {
        // Jika push lain gagal atau dibatalkan, lanjutkan penanganan lokal jika belum dibatalkan
      }
    }

    // 4. Proteksi Status Ambigu: Sesi 'needs_reconciliation' DILARANG dikirim ulang via POST otomatis
    if (sess.syncStatus === 'needs_reconciliation' && !hasValidRemoteId) {
      reconciliationCount++;
      updatedSessions.push(sess);
      continue;
    }

    // 5. Anomali: Tercatat synced tapi tidak memiliki ID Google Calendar valid
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

      const dispatchPromise = createEventFn(
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

      // Daftarkan sesi in-flight ke guard dengan composite key untuk koordinasi antar-push konkuren
      guard?.registerInFlightSession(
        sess.id,
        task.id,
        pushTicket.pushId,
        dispatchPromise,
        userId || 'user-default'
      );

      const created = await dispatchPromise;

      // User Deletion Intent Wins (Skenario B, C, D):
      // Periksa apakah selama POST sedang in-flight, pengguna menghapus sesi ini!
      if (isSessionDeleted(userId, task.id, sess.id)) {
        guard?.clearSessionState(sess.id, task.id, userId || 'user-default');

        // Rekam deletion tombstone dengan Google Calendar Event ID yang baru didapat
        const tombstone = await recordSessionDeletionDurable(userId, task.id, sess.id, created.id);
        await compensateRemoteDeletion({
          token,
          tombstone,
          deleteEventFn: params.deleteEventFn || deleteGoogleCalendarEvent,
          signal: pushTicket.signal,
          claimCleanupFn: params.cleanupClaimFn,
          syncStateFn: params.cleanupSyncStateFn,
        });

        // Sesi TIDAK dimasukkan ke updatedSessions atau newCalendarEvents (NO RESURRECTION)
        continue;
      }

      guard?.recordSessionSuccess(
        sess.id,
        task.id,
        created.id,
        created.htmlLink,
        userId || 'user-default',
        pushTicket.pushId
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
      guard?.recordSessionFailure(sess.id, task.id, userId || 'user-default', pushTicket.pushId);

      // Jika sesi telah dihapus pengguna saat error terjadi, jangan bangkitkan
      if (isSessionDeleted(userId, task.id, sess.id)) {
        continue;
      }
      const classification =
        err instanceof GoogleCalendarApiError
          ? err.classification
          : classifyGoogleCalendarError(0, err.message || '', err);

      const isPostAmbiguousError =
        Boolean((classification as any).isPostAmbiguous) ||
        classification.code === 'POST_DISPATCH_ABORTED' ||
        classification.code === 'NETWORK_ERROR' ||
        classification.code === 'INVALID_RESPONSE' ||
        classification.code === 'NEEDS_RECONCILIATION' ||
        (classification.status >= 500 && classification.status <= 599) ||
        classification.code === 'SERVICE_UNAVAILABLE' ||
        String(err.message || '').includes('tidak dapat dikonfirmasi');

      const isPreDispatchAbort =
        classification.code === 'PRE_DISPATCH_ABORTED' ||
        (classification.code === 'ABORTED' && (classification as any).phase === 'pre_dispatch');

      // Skenario A1: Pembatalan eksplisit sebelum request dikirim ke network (pre-dispatch)
      if (isPreDispatchAbort) {
        wasAborted = true;
        updatedSessions.push({
          ...sess,
          syncStatus: 'pending',
        });
        break;
      }

      // Skenario A2: Pembatalan setelah request keluar / in-flight / saat baca body (post-dispatch)
      // Server Google mungkin telah membuat event; status WAJIB 'needs_reconciliation'
      if (classification.code === 'POST_DISPATCH_ABORTED' || (classification.code === 'ABORTED' && isPostAmbiguousError)) {
        wasAborted = true;
        unconfirmedCount++;
        reconciliationCount++;
        updatedSessions.push({
          ...sess,
          syncStatus: 'needs_reconciliation',
          googleCalendarEventId: undefined,
        });
        break;
      }

      console.error('Schedule push error:', sanitizeSensitiveText(err.message || ''));

      // Skenario B: Kondisi Ambigu (HTTP 5xx pada POST, NETWORK_ERROR, INVALID_RESPONSE, ID kosong)
      // Sisi server mungkin telah membuat event namun klien kehilangan ack respons atau server error 5xx pasca-kreasi.
      // Dilarang menandai sebagai 'failed' (yang dapat memicu retry POST buta).
      // Sesi dialihkan ke 'needs_reconciliation'.
      if (isPostAmbiguousError) {
        unconfirmedCount++;
        reconciliationCount++;
        updatedSessions.push({
          ...sess,
          syncStatus: 'needs_reconciliation',
          googleCalendarEventId: undefined,
        });
      } else {
        // Skenario C: Kegagalan pasti di remote yang non-ambigu (HTTP 400, 401, 403, 404)
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

  // Persistensi data secara mutlak ke React state dan Firestore menggunakan safe merge
  const mergedPersistedTask = await persistScheduledTask({
    task: finalTask,
    userId,
    newCalendarEvents,
    setTasks,
    setEvents,
    isUpdate: isTaskUpdate,
    saveToStorage,
  });

  return {
    finalTask: mergedPersistedTask,
    updatedSessions: mergedPersistedTask.scheduledSessions || updatedSessions,
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

export interface ReconcileTaskSessionsParams {
  token: string;
  task: Task;
  userId: string | null;
  timezone?: string;
  ticket?: PushOperationTicket | SyncOperationTicket | { isStale: () => boolean; isAborted?: () => boolean; signal?: AbortSignal };
  signal?: AbortSignal;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setEvents?: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
  fetchEventsFn?: (
    accessToken: string,
    timeMin?: Date,
    timeMax?: Date,
    signal?: AbortSignal
  ) => Promise<{ events: CalendarEvent[]; rangeStart?: string; rangeEnd?: string }>;
  deleteEventFn?: (
    accessToken: string,
    googleEventId: string,
    signal?: AbortSignal
  ) => Promise<void>;
  cleanupClaimFn?: Parameters<typeof compensateRemoteDeletion>[0]['claimCleanupFn'];
  cleanupSyncStateFn?: Parameters<typeof compensateRemoteDeletion>[0]['syncStateFn'];
  saveToStorage?: (task: Task, userId: string) => Promise<void>;
}

export interface ReconcileTaskSessionsResult {
  updatedTask: Task;
  reconciledCount: number;
  stillAmbiguousCount: number;
  notFoundCount: number;
  isStale: boolean;
}

/**
 * Alur rekonsiliasi produksi end-to-end untuk memulihkan sesi berstatus 'needs_reconciliation'.
 *
 * Prinsip Rekonsiliasi:
 * 1. Mengambil agenda remote dari Google Calendar dalam rentang sesi.
 * 2. Meneruskan AbortSignal ke remote fetch untuk membatalkan operasi saat sinyal aktif.
 * 3. Mencari berdasarkan identitas stabil extendedProperties.private (evenTaskId dan evenSessionId).
 * 4. Tepat satu kandidat -> status menjadi 'synced' dan ID remote tersimpan persisten.
 * 5. Lebih dari satu kandidat -> status tetap 'needs_reconciliation' (dilarang memilih otomatis).
 * 6. Nol kandidat -> status tetap 'needs_reconciliation' yang aman (dilarang langsung membuat POST baru).
 * 7. Hasil dipersistensikan ke React state dan Firestore hanya jika operasi belum stale dan belum dibatalkan.
 * 8. Operasi yang stale / dibatalkan tidak boleh mengubah status koneksi, React state, atau Firestore.
 */
export async function reconcileTaskSessionsWithRemote(
  params: ReconcileTaskSessionsParams
): Promise<ReconcileTaskSessionsResult> {
  const {
    token,
    task,
    userId,
    ticket,
    setTasks,
    setEvents,
    fetchEventsFn = fetchGoogleCalendarEvents,
    saveToStorage,
  } = params;

  const activeSignal = params.signal || (ticket && 'signal' in ticket ? (ticket as any).signal : undefined);

  const checkIsAborted = (): boolean => {
    if (activeSignal?.aborted) return true;
    if (ticket) {
      if ('isAborted' in ticket && typeof (ticket as any).isAborted === 'function') {
        return (ticket as any).isAborted();
      }
      if ((ticket as any).signal?.aborted) {
        return true;
      }
    }
    return false;
  };

  const checkIsStale = (): boolean => {
    return Boolean(ticket?.isStale());
  };

  // 1. Abort atau stale sebelum fetch: DILARANG memulai request fetch
  if (checkIsStale() || checkIsAborted()) {
    return {
      updatedTask: task,
      reconciledCount: 0,
      stillAmbiguousCount: 0,
      notFoundCount: 0,
      isStale: true,
    };
  }

  const needsReconciliationSessions = (task.scheduledSessions || []).filter(
    (s) => s.syncStatus === 'needs_reconciliation'
  );

  if (needsReconciliationSessions.length === 0) {
    return {
      updatedTask: task,
      reconciledCount: 0,
      stillAmbiguousCount: 0,
      notFoundCount: 0,
      isStale: checkIsStale(),
    };
  }

  // Hitung rentang waktu untuk fetch Google Calendar (+/- 3 hari untuk toleransi timezone)
  const timestamps = needsReconciliationSessions
    .flatMap((s) => [new Date(s.startAt).getTime(), new Date(s.endAt).getTime()])
    .filter((t) => !isNaN(t));

  const minTime = timestamps.length > 0 ? new Date(Math.min(...timestamps) - 3 * 86400000) : undefined;
  const maxTime = timestamps.length > 0 ? new Date(Math.max(...timestamps) + 3 * 86400000) : undefined;

  let remoteEvents: CalendarEvent[] = [];
  try {
    const fetchRes = await fetchEventsFn(token, minTime, maxTime, activeSignal);
    remoteEvents = fetchRes.events || [];
  } catch (err: any) {
    const wasAborted =
      checkIsStale() ||
      checkIsAborted() ||
      err?.name === 'AbortError' ||
      String(err?.message || '').toLowerCase().includes('abort');

    if (wasAborted) {
      return {
        updatedTask: task,
        reconciledCount: 0,
        stillAmbiguousCount: 0,
        notFoundCount: 0,
        isStale: true,
      };
    }

    console.error('Failed to fetch remote events during reconciliation:', err);
    return {
      updatedTask: task,
      reconciledCount: 0,
      stillAmbiguousCount: needsReconciliationSessions.length,
      notFoundCount: 0,
      isStale: checkIsStale(),
    };
  }

  // 2. Abort atau stale saat fetch berlangsung atau sebelum memproses hasil: DILARANG memproses hasil
  if (checkIsStale() || checkIsAborted()) {
    return {
      updatedTask: task,
      reconciledCount: 0,
      stillAmbiguousCount: 0,
      notFoundCount: 0,
      isStale: true,
    };
  }

  let reconciledCount = 0;
  let stillAmbiguousCount = 0;
  let notFoundCount = 0;
  const newCalendarEvents: CalendarEvent[] = [];

  const updatedSessions = (task.scheduledSessions || []).map((sess) => {
    if (sess.syncStatus !== 'needs_reconciliation') {
      return sess;
    }

    const recon = reconcileSessionWithRemoteEvents(
      {
        id: sess.id,
        taskId: task.id,
        googleCalendarEventId: sess.googleCalendarEventId,
        title: sess.taskTitle,
      },
      remoteEvents
    );

    if (recon.status === 'confirmed' && recon.remoteEventId) {
      // User Deletion Intent Wins (Skenario D & M):
      // Jika pengguna telah menghapus sesi ini, jangan pernah menghidupkan kembali ke aplikasi!
      if (isSessionDeleted(userId, task.id, sess.id)) {
        recordSessionDeletionDurable(userId, task.id, sess.id, recon.remoteEventId)
          .then((tombstone) => compensateRemoteDeletion({
            token,
            tombstone,
            deleteEventFn: params.deleteEventFn || deleteGoogleCalendarEvent,
            signal: activeSignal,
            claimCleanupFn: params.cleanupClaimFn,
            syncStateFn: params.cleanupSyncStateFn,
          }))
          .catch((err) => console.warn('Durable remote cleanup intent was retained for retry:', err));
        return null;
      }

      reconciledCount++;
      const confirmedRemoteId = recon.remoteEventId;
      const htmlLink = recon.htmlLink || sess.htmlLink;

      newCalendarEvents.push({
        id: `gcal-${confirmedRemoteId}`,
        provider: 'google',
        title: `[EVEN] ${sess.taskTitle}`,
        startAt: sess.startAt,
        endAt: sess.endAt,
        htmlLink,
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

      return {
        ...sess,
        syncStatus: 'synced' as const,
        googleCalendarEventId: confirmedRemoteId,
        htmlLink,
      };
    }

    if (recon.status === 'ambiguous') {
      stillAmbiguousCount++;
      return {
        ...sess,
        syncStatus: 'needs_reconciliation' as const,
      };
    }

    // not_found: tetap dalam status yang aman 'needs_reconciliation'
    // DILARANG langsung mengirim POST baru tanpa kebijakan pemulihan eksplisit
    notFoundCount++;
    return {
      ...sess,
      syncStatus: 'needs_reconciliation' as const,
      googleCalendarEventId: undefined,
    };
  });

  const cleanedSessions = updatedSessions.filter((s): s is TaskScheduleSession => s !== null);

  const updatedTask: Task = {
    ...task,
    scheduledSessions: cleanedSessions,
  };

  // 3. Operasi stale / aborted DILARANG mengubah state atau Firestore
  if (checkIsStale() || checkIsAborted()) {
    return {
      updatedTask: task,
      reconciledCount: 0,
      stillAmbiguousCount: 0,
      notFoundCount: 0,
      isStale: true,
    };
  }

  // Persistensikan secara mutlak ke React state dan Firestore
  await persistScheduledTask({
    task: updatedTask,
    userId,
    newCalendarEvents: newCalendarEvents.length > 0 ? newCalendarEvents : undefined,
    setTasks,
    setEvents,
    isUpdate: true,
    saveToStorage,
  });

  return {
    updatedTask,
    reconciledCount,
    stillAmbiguousCount,
    notFoundCount,
    isStale: checkIsStale(),
  };
}
