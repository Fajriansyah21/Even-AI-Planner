/**
 * Deletion Intent Tombstone & Remote Compensation Cleaner
 *
 * Implements persistent recording of user deletion decisions ("User Deletion Intent Wins").
 * Prevents resurrection of deleted tasks or sessions when delayed/stale calendar pushes resolve.
 * Orchestrates remote event compensation (cleanup DELETE) and persistent retry queue.
 */

import { deleteGoogleCalendarEvent } from './googleCalendar';

export type TombstoneCleanupStatus =
  | 'pending_cleanup'
  | 'cleaning'
  | 'cleaned'
  | 'cleanup_failed';

export interface DeletionTombstone {
  /** Unique key: `${userId}:${taskId}:${sessionId || 'all'}` */
  id: string;
  userId: string;
  taskId: string;
  sessionId?: string;
  googleCalendarEventId?: string;
  deletedAt: string; // ISO 8601 string
  status: TombstoneCleanupStatus;
  retryCount: number;
  lastError?: string;
  lastAttemptAt?: string;
}

const STORAGE_KEY = 'even_deletion_tombstones_v1';

// In-memory cache for fast, synchronous lookups within the same session
const inMemoryTombstones = new Map<string, DeletionTombstone>();

/**
 * Builds standard composite key for tombstone indexing
 */
export function buildTombstoneKey(
  userId: string | null | undefined,
  taskId: string,
  sessionId?: string
): string {
  const safeUser = userId && userId.trim() ? userId : 'user-default';
  return `${safeUser}:${taskId}:${sessionId || 'all'}`;
}

/**
 * Loads all tombstones from persistent storage (localStorage) into memory
 */
export function loadTombstonesFromStorage(): DeletionTombstone[] {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: DeletionTombstone[] = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          parsed.forEach((t) => {
            if (t && t.id) {
              inMemoryTombstones.set(t.id, t);
            }
          });
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn('Failed to load tombstones from localStorage:', err);
  }
  return Array.from(inMemoryTombstones.values());
}

/**
 * Flushes in-memory tombstones to persistent storage
 */
export function saveTombstonesToStorage(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const list = Array.from(inMemoryTombstones.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    }
  } catch (err) {
    console.warn('Failed to save tombstones to localStorage:', err);
  }
}

/**
 * Checks if a session or task has been deleted by user intent.
 * Checks both specific session tombstone and whole-task tombstone.
 */
export function isSessionDeleted(
  userId: string | null | undefined,
  taskId: string,
  sessionId?: string
): boolean {
  const safeUser = userId && userId.trim() ? userId : 'user-default';

  // 1. Check whole-task tombstone
  const taskKey = buildTombstoneKey(safeUser, taskId);
  if (inMemoryTombstones.has(taskKey)) {
    return true;
  }

  // 2. Check specific session tombstone
  if (sessionId) {
    const sessionKey = buildTombstoneKey(safeUser, taskId, sessionId);
    if (inMemoryTombstones.has(sessionKey)) {
      return true;
    }
  }

  // 3. Fallback: reload from localStorage if not found in memory (e.g. cross-tab or after restart)
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const list: DeletionTombstone[] = JSON.parse(raw);
        const match = list.find((t) => {
          if (t.userId !== safeUser || t.taskId !== taskId) return false;
          if (!t.sessionId || t.sessionId === 'all') return true;
          return sessionId && t.sessionId === sessionId;
        });
        if (match) {
          inMemoryTombstones.set(match.id, match);
          return true;
        }
      }
    } catch {
      // ignore parsing error
    }
  }

  return false;
}

/**
 * Records a deletion intent for an individual session.
 */
export function recordSessionDeletion(
  userId: string | null | undefined,
  taskId: string,
  sessionId: string,
  googleCalendarEventId?: string
): DeletionTombstone {
  const key = buildTombstoneKey(userId, taskId, sessionId);
  const existing = inMemoryTombstones.get(key);

  const finalRemoteId = googleCalendarEventId || existing?.googleCalendarEventId;
  const status: TombstoneCleanupStatus = finalRemoteId ? 'pending_cleanup' : 'cleaned';

  const tombstone: DeletionTombstone = {
    id: key,
    userId: userId && userId.trim() ? userId : 'user-default',
    taskId,
    sessionId,
    googleCalendarEventId: finalRemoteId,
    deletedAt: existing?.deletedAt || new Date().toISOString(),
    status,
    retryCount: existing?.retryCount || 0,
    lastError: existing?.lastError,
    lastAttemptAt: existing?.lastAttemptAt,
  };

  inMemoryTombstones.set(key, tombstone);
  saveTombstonesToStorage();
  return tombstone;
}

/**
 * Records a deletion intent for a whole task, including all associated sessions.
 */
export function recordTaskDeletion(
  userId: string | null | undefined,
  taskId: string,
  sessions?: { sessionId: string; googleCalendarEventId?: string }[]
): DeletionTombstone[] {
  const safeUser = userId && userId.trim() ? userId : 'user-default';
  const tombstones: DeletionTombstone[] = [];

  // 1. Task-level tombstone
  const taskKey = buildTombstoneKey(safeUser, taskId);
  const taskTombstone: DeletionTombstone = {
    id: taskKey,
    userId: safeUser,
    taskId,
    deletedAt: new Date().toISOString(),
    status: 'cleaned',
    retryCount: 0,
  };
  inMemoryTombstones.set(taskKey, taskTombstone);
  tombstones.push(taskTombstone);

  // 2. Session-level tombstones for any sessions with existing or potential remote IDs
  if (sessions && sessions.length > 0) {
    for (const sess of sessions) {
      const sessTombstone = recordSessionDeletion(
        safeUser,
        taskId,
        sess.sessionId,
        sess.googleCalendarEventId
      );
      tombstones.push(sessTombstone);
    }
  }

  saveTombstonesToStorage();
  return tombstones;
}

/**
 * Updates status and metadata of a tombstone.
 */
export function updateTombstone(
  id: string,
  updates: Partial<DeletionTombstone>
): DeletionTombstone | undefined {
  const existing = inMemoryTombstones.get(id);
  if (!existing) return undefined;

  const updated: DeletionTombstone = {
    ...existing,
    ...updates,
  };
  inMemoryTombstones.set(id, updated);
  saveTombstonesToStorage();
  return updated;
}

/**
 * Returns all active tombstones, optionally filtered by userId.
 */
export function getTombstones(userId?: string): DeletionTombstone[] {
  loadTombstonesFromStorage();
  const all = Array.from(inMemoryTombstones.values());
  if (userId) {
    return all.filter((t) => t.userId === userId);
  }
  return all;
}

/**
 * Clears all in-memory and persistent tombstones (used for testing and hard resets).
 */
export function clearAllTombstones(): void {
  inMemoryTombstones.clear();
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

export interface CompensateRemoteDeletionOptions {
  token: string;
  tombstone: DeletionTombstone;
  deleteEventFn?: (accessToken: string, googleEventId: string, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Executes remote event compensation (DELETE) for a tombstoned session.
 * Idempotent: Handles 404/410 by marking as cleaned.
 */
export async function compensateRemoteDeletion(
  options: CompensateRemoteDeletionOptions
): Promise<{ success: boolean; tombstone: DeletionTombstone }> {
  const { token, tombstone, deleteEventFn = deleteGoogleCalendarEvent, signal } = options;

  if (!tombstone.googleCalendarEventId) {
    // No remote ID to delete, consider already cleaned
    const updated = updateTombstone(tombstone.id, { status: 'cleaned' }) || tombstone;
    return { success: true, tombstone: updated };
  }

  updateTombstone(tombstone.id, {
    status: 'cleaning',
    lastAttemptAt: new Date().toISOString(),
  });

  try {
    await deleteEventFn(token, tombstone.googleCalendarEventId, signal);
    const updated = updateTombstone(tombstone.id, {
      status: 'cleaned',
      lastError: undefined,
    }) || tombstone;
    return { success: true, tombstone: updated };
  } catch (err: any) {
    // Check if error represents 404 (Not Found) or 410 (Gone) -> already deleted remotely
    const status = err?.status || err?.classification?.status;
    if (status === 404 || status === 410) {
      const updated = updateTombstone(tombstone.id, {
        status: 'cleaned',
        lastError: undefined,
      }) || tombstone;
      return { success: true, tombstone: updated };
    }

    const updated = updateTombstone(tombstone.id, {
      status: 'cleanup_failed',
      retryCount: (tombstone.retryCount || 0) + 1,
      lastError: err?.message || 'Remote DELETE failed',
      lastAttemptAt: new Date().toISOString(),
    }) || tombstone;

    return { success: false, tombstone: updated };
  }
}

export interface ProcessPendingCleanupsOptions {
  token: string;
  userId?: string;
  deleteEventFn?: (accessToken: string, googleEventId: string, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Processes all pending or failed cleanup jobs.
 * Safe to call on application restart or after network recovery.
 */
export async function processPendingDeletionCleanups(
  options: ProcessPendingCleanupsOptions
): Promise<{
  totalProcessed: number;
  cleanedCount: number;
  failedCount: number;
}> {
  const { token, userId, deleteEventFn, signal } = options;
  const tombstones = getTombstones(userId);

  const pending = tombstones.filter(
    (t) =>
      (t.status === 'pending_cleanup' || t.status === 'cleanup_failed') &&
      Boolean(t.googleCalendarEventId)
  );

  let cleanedCount = 0;
  let failedCount = 0;

  for (const t of pending) {
    if (signal?.aborted) break;
    const res = await compensateRemoteDeletion({
      token,
      tombstone: t,
      deleteEventFn,
      signal,
    });
    if (res.success) {
      cleanedCount++;
    } else {
      failedCount++;
    }
  }

  return {
    totalProcessed: pending.length,
    cleanedCount,
    failedCount,
  };
}

// Automatically load tombstones on module initialization
loadTombstonesFromStorage();
