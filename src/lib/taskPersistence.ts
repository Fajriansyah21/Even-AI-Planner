import type React from 'react';
import { Task, TaskScheduleSession, CalendarEvent } from '../types';
import { db, sanitizeForFirestore, handleFirestoreError, OperationType } from './firebase';
import { doc, setDoc } from 'firebase/firestore';

export interface PersistScheduledTaskOptions {
  task: Task;
  userId: string | null;
  newCalendarEvents?: CalendarEvent[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setEvents?: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
  isUpdate?: boolean;
  saveToStorage?: (task: Task, userId: string) => Promise<void>;
  getCurrentTask?: () => Task | undefined;
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
 * 5. Penanganan Sesi yang Dihapus / Diubah:
 *    - Jika suatu sesi dihapus dari currentTask saat push berlangsung, namun push telah telanjur memperoleh
 *      ID remote di Google Calendar, sesi tersebut dipertahankan agar ID remote tidak menjadi orphan.
 */
export function mergeTaskWithCurrent(currentTask: Task, pushingTask: Task): Task {
  if (!currentTask || currentTask.id !== pushingTask.id) {
    return pushingTask;
  }

  const currentSessions = currentTask.scheduledSessions || [];
  const pushingSessions = pushingTask.scheduledSessions || [];

  const mergedSessions: TaskScheduleSession[] = [];
  const processedSessionIds = new Set<string>();

  // 1. Iterasi seluruh sesi pada task terkini (currentTask)
  for (const currSess of currentSessions) {
    processedSessionIds.add(currSess.id);
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

  // 2. Jika sesi dalam pushingTask telah memperoleh remote ID namun dihapus dari currentTask:
  // Pertahankan sesi tersebut agar ID remote tidak hilang dan tidak menjadi yatim di Google Calendar
  for (const pushSess of pushingSessions) {
    if (!processedSessionIds.has(pushSess.id)) {
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
 * Menerapkan Safe Merge:
 * - Mengambil state task terbaru dari React state sebelum melakukan persistensi.
 * - Menggunakan mergeTaskWithCurrent() untuk menyatukan remote ID baru tanpa menimpa data task terbaru.
 * - Menjamin konsistensi 100% antara state React dan dokumen Firestore.
 */
export async function persistScheduledTask(options: PersistScheduledTaskOptions): Promise<Task> {
  const { task, userId, newCalendarEvents, setTasks, setEvents, isUpdate = true, getCurrentTask } = options;

  let mergedResult: Task = task;

  // 1. Simpan ke React task state dengan safe merge
  setTasks((prev) => {
    const existing = prev.find((t) => t.id === task.id);
    if (existing) {
      mergedResult = mergeTaskWithCurrent(existing, task);
      return prev.map((t) => (t.id === task.id ? mergedResult : t));
    }
    const externalCurrent = getCurrentTask?.();
    if (externalCurrent && externalCurrent.id === task.id) {
      mergedResult = mergeTaskWithCurrent(externalCurrent, task);
    } else {
      mergedResult = task;
    }
    return [mergedResult, ...prev];
  });

  // 2. Tambahkan agenda kalender baru yang berhasil dibuat (jika ada)
  if (newCalendarEvents && newCalendarEvents.length > 0 && setEvents) {
    setEvents((prev) => {
      const existingIds = new Set(prev.map((e) => e.id));
      const fresh = newCalendarEvents.filter((e) => !existingIds.has(e.id));
      return [...prev, ...fresh];
    });
  }

  // 3. Persistensi ke Firestore menggunakan hasil merged yang sama persis
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
