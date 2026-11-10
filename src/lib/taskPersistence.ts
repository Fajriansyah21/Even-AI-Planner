import type React from 'react';
import { Task, TaskScheduleSession, CalendarEvent } from '../types';
import { db, sanitizeForFirestore, handleFirestoreError, OperationType } from './firebase';
import { doc, setDoc } from 'firebase/firestore';

import { isSessionDeleted, recordSessionDeletion } from './deletionTombstone';

export interface PersistScheduledTaskOptions {
  task: Task;
  userId: string | null;
  newCalendarEvents?: CalendarEvent[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setEvents?: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
  isUpdate?: boolean;
  saveToStorage?: (task: Task, userId: string) => Promise<void>;
  getCurrentTask?: () => Task | undefined;
  currentTask?: Task;
  allTasks?: Task[];
}

export interface MergeTaskOptions {
  userId?: string | null;
}

/**
 * Menggabungkan (merge) snapshot task dari operasi push ke dalam state task terkini (currentTask)
 * dengan kebijakan resolusi konflik yang eksplisit dan aman:
 *
 * 1. Base Task Metadata:
 *    - Seluruh perubahan pengguna terbaru pada currentTask (judul, deskripsi, prioritas, status, tenggat)
 *      dipertahankan secara mutlak. Snapshot lama dari push DILARANG menimpa metadata task terbaru.
 * 2. Session Integrity & Identity:
 *    - Setiap sesi dicocokkan berdasarkan session.id.
 *    - Sesi lain pada currentTask yang tidak diproses oleh push ini dipertahankan 100% utuh.
 * 3. Remote Event ID Protection:
 *    - Jika currentTask sudah memiliki ID remote valid, ID tersebut tidak boleh ditimpa oleh snapshot lama.
 *    - Jika operasi push berhasil memperoleh ID remote baru, ID tersebut disematkan ke sesi yang sesuai.
 * 4. Sync Status Resolution:
 *    - Status 'synced' yang sudah terkonfirmasi tidak boleh diturunkan kembali ke 'pending' atau 'failed'.
 *    - Status 'needs_reconciliation' dipertahankan jika belum terkonfirmasi remote ID.
 * 5. User Deletion Intent Wins (NO RESURRECTION):
 *    - Jika suatu sesi atau task tercatat di Deletion Tombstone, sesi tersebut DILARANG dikembalikan (resurrected).
 *    - Jika sesi yang dihapus memiliki remote ID, remote ID dicatat ke tombstone untuk kompensasi pembersihan remote.
 */
export function mergeTaskWithCurrent(
  currentTask: Task,
  pushingTask: Task,
  options?: MergeTaskOptions
): Task {
  if (!currentTask || currentTask.id !== pushingTask.id) {
    return pushingTask;
  }

  const safeUser = options?.userId || currentTask.userId || pushingTask.userId;

  // Jika keseluruhan task telah dihapus pengguna, jangan bangkitkan kembali
  if (isSessionDeleted(safeUser, pushingTask.id)) {
    return {
      ...currentTask,
      status: 'DELETED' as any,
      scheduledSessions: [],
      updatedAt: new Date().toISOString(),
    };
  }

  const currentSessions = currentTask.scheduledSessions || [];
  const pushingSessions = pushingTask.scheduledSessions || [];

  const mergedSessions: TaskScheduleSession[] = [];
  const processedSessionIds = new Set<string>();

  // 1. Iterasi seluruh sesi pada task terkini (currentTask)
  for (const currSess of currentSessions) {
    processedSessionIds.add(currSess.id);

    // Periksa apakah sesi ini telah dihapus oleh pengguna
    if (isSessionDeleted(safeUser, pushingTask.id, currSess.id)) {
      continue;
    }

    const pushSess = pushingSessions.find((s) => s.id === currSess.id);

    if (!pushSess) {
      // Sesi ini tidak tersentuh oleh push -> pertahankan utuh
      mergedSessions.push(currSess);
      continue;
    }

    // Resolusi Google Calendar Event ID & htmlLink
    const hasCurrentRemoteId =
      typeof currSess.googleCalendarEventId === 'string' &&
      currSess.googleCalendarEventId.trim().length > 0;
    const hasPushRemoteId =
      typeof pushSess.googleCalendarEventId === 'string' &&
      pushSess.googleCalendarEventId.trim().length > 0;

    let finalRemoteId: string | undefined = undefined;
    let finalHtmlLink: string | undefined = undefined;

    if (hasCurrentRemoteId) {
      // Prioritaskan ID remote yang sudah ada pada currentTask (lebih baru / terkonfirmasi)
      finalRemoteId = currSess.googleCalendarEventId;
      finalHtmlLink = currSess.htmlLink;
    } else if (hasPushRemoteId) {
      // Adopsi ID remote baru yang berhasil diperoleh dari operasi push
      finalRemoteId = pushSess.googleCalendarEventId;
      finalHtmlLink = pushSess.htmlLink;
    }

    // Resolusi Sync Status
    let finalSyncStatus = currSess.syncStatus;
    if (hasCurrentRemoteId && currSess.syncStatus === 'synced') {
      finalSyncStatus = 'synced';
    } else if (hasPushRemoteId && (pushSess.syncStatus === 'synced' || !hasCurrentRemoteId)) {
      finalSyncStatus = 'synced';
    } else if (pushSess.syncStatus === 'needs_reconciliation' && !hasCurrentRemoteId) {
      finalSyncStatus = 'needs_reconciliation';
    } else if (currSess.syncStatus === 'needs_reconciliation') {
      finalSyncStatus = 'needs_reconciliation';
    } else if (currSess.syncStatus) {
      finalSyncStatus = currSess.syncStatus;
    } else {
      finalSyncStatus = pushSess.syncStatus || 'pending';
    }

    mergedSessions.push({
      ...currSess,
      googleCalendarEventId: finalRemoteId,
      htmlLink: finalHtmlLink,
      syncStatus: finalSyncStatus,
    });
  }

  // 2. Periksa sesi dalam pushingTask yang tidak ada di currentTask
  for (const pushSess of pushingSessions) {
    if (!processedSessionIds.has(pushSess.id)) {
      // Jika sesi ini telah dihapus oleh pengguna:
      // USER DELETION INTENT WINS: Sesi DILARANG dihidupkan kembali (NO RESURRECTION).
      if (isSessionDeleted(safeUser, pushingTask.id, pushSess.id)) {
        if (pushSess.googleCalendarEventId) {
          recordSessionDeletion(safeUser, pushingTask.id, pushSess.id, pushSess.googleCalendarEventId);
        }
        continue;
      }

      const hasPushRemoteId =
        typeof pushSess.googleCalendarEventId === 'string' &&
        pushSess.googleCalendarEventId.trim().length > 0;
      if (hasPushRemoteId || pushSess.syncStatus === 'needs_reconciliation') {
        mergedSessions.push(pushSess);
      }
    }
  }

  // Gabungkan dengan mempertahankan seluruh metadata terbaru dari currentTask
  return {
    ...currentTask,
    userId: currentTask.userId || pushingTask.userId,
    status: currentTask.status || pushingTask.status,
    title: currentTask.title || pushingTask.title,
    description:
      currentTask.description !== undefined ? currentTask.description : pushingTask.description,
    priority: currentTask.priority || pushingTask.priority,
    deadline: currentTask.deadline ?? pushingTask.deadline,
    estimatedDurationMinutes:
      currentTask.estimatedDurationMinutes ?? pushingTask.estimatedDurationMinutes,
    minimumSessionMinutes:
      currentTask.minimumSessionMinutes ?? pushingTask.minimumSessionMinutes,
    allowSplit: currentTask.allowSplit ?? pushingTask.allowSplit,
    scheduledSessions: mergedSessions,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Menyimpan tugas secara persisten ke state React dan Firestore (jika terautentikasi),
 * serta menambahkan acara kalender yang berhasil dibuat.
 *
 * Menerapkan Deterministik Safe Merge & Pure Functional Updaters:
 * - Menentukan state awal task terkini secara otoritatif sebelum mutasi.
 * - Menggunakan functional updater murni tanpa side effect di dalam setState callback.
 * - Menjamin konsistensi 100% antara state React dan dokumen Firestore.
 */
export async function persistScheduledTask(options: PersistScheduledTaskOptions): Promise<Task> {
  const {
    task,
    userId,
    newCalendarEvents,
    setTasks,
    setEvents,
    isUpdate = true,
    getCurrentTask,
    currentTask,
    allTasks,
  } = options;

  // 1. Dapatkan task otoritatif saat ini sebelum persistence
  const authoritativeTask =
    currentTask ||
    getCurrentTask?.() ||
    (allTasks ? allTasks.find((t) => t.id === task.id) : undefined);

  const initialMerged = authoritativeTask
    ? mergeTaskWithCurrent(authoritativeTask, task, { userId })
    : task;

  let mergedResult = initialMerged;

  // 2. Simpan ke React task state dengan updater fungsional murni jika setTasks disediakan
  if (setTasks) {
    setTasks((prev) => {
      const existingInPrev = prev.find((t) => t.id === task.id);
      if (existingInPrev) {
        const finalMerged = mergeTaskWithCurrent(existingInPrev, initialMerged, { userId });
        mergedResult = finalMerged;
        return prev.map((t) => (t.id === task.id ? finalMerged : t));
      }
      return [initialMerged, ...prev];
    });
  }

  // 3. Tambahkan agenda kalender baru yang berhasil dibuat (jika ada)
  if (newCalendarEvents && newCalendarEvents.length > 0 && setEvents) {
    setEvents((prev) => {
      const existingIds = new Set(prev.map((e) => e.id));
      const fresh = newCalendarEvents.filter((e) => !existingIds.has(e.id));
      return [...prev, ...fresh];
    });
  }

  // 4. Persistensi ke Firestore menggunakan hasil merged deterministik
  if (userId && userId !== 'user-default') {
    try {
      if (options.saveToStorage) {
        await options.saveToStorage(mergedResult, userId);
      } else {
        await setDoc(
          doc(db, 'users', userId, 'tasks', mergedResult.id),
          sanitizeForFirestore(mergedResult)
        );
      }
    } catch (err) {
      handleFirestoreError(
        err,
        isUpdate ? OperationType.UPDATE : OperationType.CREATE,
        `users/${userId}/tasks/${mergedResult.id}`
      );
    }
  }

  return mergedResult;
}
