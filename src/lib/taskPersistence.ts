import type React from 'react';
import { Task, CalendarEvent } from '../types';
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
}

/**
 * Menyimpan tugas secara persisten ke state React dan Firestore (jika terautentikasi),
 * serta menambahkan acara kalender yang berhasil dibuat.
 *
 * Fungsi ini mengisolasi logika persistensi data dari status autentikasi/diagnostik kalender,
 * sehingga operasi push yang berstatus stale (misal karena disconnect atau push baru)
 * tetap menyimpan seluruh sesi (baik yang berhasil dibuat di Google maupun yang pending)
 * ke penyimpanan persisten tanpa merusak status koneksi terkini.
 */
export async function persistScheduledTask(options: PersistScheduledTaskOptions): Promise<void> {
  const { task, userId, newCalendarEvents, setTasks, setEvents, isUpdate = true } = options;

  // 1. Simpan ke React task state
  setTasks((prev) => {
    const exists = prev.some((t) => t.id === task.id);
    if (exists) {
      return prev.map((t) => (t.id === task.id ? task : t));
    }
    return [task, ...prev];
  });

  // 2. Tambahkan agenda kalender baru yang berhasil dibuat (jika ada)
  if (newCalendarEvents && newCalendarEvents.length > 0 && setEvents) {
    setEvents((prev) => {
      const existingIds = new Set(prev.map((e) => e.id));
      const fresh = newCalendarEvents.filter((e) => !existingIds.has(e.id));
      return [...prev, ...fresh];
    });
  }

  // 3. Persistensi ke Firestore jika pengguna terautentikasi
  if (userId && userId !== 'user-default') {
    try {
      if (options.saveToStorage) {
        await options.saveToStorage(task, userId);
      } else {
        await setDoc(
          doc(db, 'users', userId, 'tasks', task.id),
          sanitizeForFirestore(task)
        );
      }
    } catch (err) {
      handleFirestoreError(
        err,
        isUpdate ? OperationType.UPDATE : OperationType.CREATE,
        `users/${userId}/tasks/${task.id}`
      );
    }
  }
}
