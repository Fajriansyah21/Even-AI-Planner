/**
 * Task Deletion Workflow Module
 *
 * Implements the production task deletion workflow adhering to the principle:
 * "User Deletion Intent Wins" and "Durable Before Ephemeral".
 *
 * Steps:
 * 1. Awaits durable tombstone persistence in IndexedDB outbox.
 * 2. On failure: aborts deletion, keeps React state intact, prevents remote DELETE, prevents Firestore delete, alerts user.
 * 3. On success: mutates React state, closes modal, sends success toast, triggers background remote event DELETE, and deletes Firestore document.
 */

import { doc, deleteDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, getCachedAccessToken } from './firebase';
import { Task } from '../types';
import {
  compensateRemoteDeletion,
  DeletionTombstone,
  recordTaskDeletionDurable,
} from './deletionTombstone';
import { deleteGoogleCalendarEvent } from './googleCalendar';

export interface ExecuteTaskDeletionParams {
  userId: string | null;
  task: Task;
  setTasks: (updater: (prev: Task[]) => Task[]) => void;
  showToast: (msg: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  closeModal: () => void;
  // Optional dependency injection hooks for integration testing & verification
  recordDurableFn?: (
    userId: string | null | undefined,
    taskId: string,
    sessions?: { sessionId: string; googleCalendarEventId?: string }[]
  ) => Promise<any>;
  deleteRemoteEventFn?: (accessToken: string, eventId: string) => Promise<any>;
  deleteFirestoreDocFn?: (docRef: any) => Promise<void>;
  getCachedTokenFn?: () => string | null;
  compensateRemoteDeletionFn?: typeof compensateRemoteDeletion;
}

export async function executeTaskDeletion(params: ExecuteTaskDeletionParams): Promise<boolean> {
  const { userId, task, setTasks, showToast, closeModal } = params;
  const recordDurable = params.recordDurableFn || recordTaskDeletionDurable;
  const deleteRemoteEvent = params.deleteRemoteEventFn || deleteGoogleCalendarEvent;
  const deleteFirestoreDoc = params.deleteFirestoreDocFn || (async (ref) => { await deleteDoc(ref); });
  const getCachedToken = params.getCachedTokenFn || getCachedAccessToken;
  const compensate = params.compensateRemoteDeletionFn || compensateRemoteDeletion;
  let durableTombstones: DeletionTombstone[] = [];

  // Prepare session list with any remote event IDs
  const sessionsWithEvents = task.scheduledSessions?.map((s) => ({
    sessionId: s.id,
    googleCalendarEventId: s.googleCalendarEventId,
  }));

  // 1. Rekam tombstone persisten secara durable ke outbox IndexedDB TERLEBIH DAHULU
  try {
    durableTombstones = await recordDurable(userId || 'user-default', task.id, sessionsWithEvents) || [];
  } catch (err) {
    console.error('Penyimpanan tombstone durable ke outbox gagal:', err);
    showToast('Gagal menghapus kegiatan: penyimpanan lokal gagal.', 'error');
    // Abort: jangan ubah React state, jangan hapus dari Firestore, jangan remote DELETE
    closeModal();
    return false;
  }

  // 2. Jika durable record berhasil, mutasikan UI state dan tampilkan konfirmasi
  setTasks((prev) => prev.filter((t) => t.id !== task.id));
  showToast(`Kegiatan "${task.title}" telah dihapus.`, 'info');
  closeModal();

  // 3. Kompensasikan penghapusan remote jika ada Google Calendar Event ID
  const cachedToken = getCachedToken();
  if (cachedToken && sessionsWithEvents && sessionsWithEvents.length > 0) {
    for (const s of sessionsWithEvents) {
      if (!s.googleCalendarEventId) continue;
      const tombstone = durableTombstones.find((item) => item.sessionId === s.sessionId);
      // Never dispatch a remote DELETE without its durable, identity-bound tombstone.
      if (!tombstone) continue;
      void compensate({
        token: cachedToken,
        tombstone,
        deleteEventFn: deleteRemoteEvent,
      }).catch((err) => {
        console.warn('Background remote delete compensation failed:', err);
      });
    }
  }

  // 4. Hapus dokumen task dari Firestore
  if (userId && userId !== 'user-default') {
    try {
      await deleteFirestoreDoc(doc(db, 'users', userId, 'tasks', task.id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${userId}/tasks/${task.id}`);
    }
  }

  return true;
}
