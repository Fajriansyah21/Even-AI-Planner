/**
 * Deletion Intent Tombstone & Remote Compensation Cleaner
 *
 * Implements persistent recording of user deletion decisions ("User Deletion Intent Wins").
 * Prevents resurrection of deleted tasks or sessions when delayed/stale calendar pushes resolve.
 * Orchestrates remote event compensation (cleanup DELETE) and persistent retry queue.
 */

import { deleteGoogleCalendarEvent } from './googleCalendar';
import {
  saveToOutbox,
  DurableDeletionIntent,
  clearIndexedDbOutbox,
  getAllOutboxItems,
  getOutboxItem,
  migrateLocalStorageToIndexedDb,
} from './indexedDbOutbox';
import {
  claimAuthoritativeRemoteCleanup,
  syncOutboxToFirestore,
  reconcileRemoteTombstonesToLocal,
} from './firestoreTombstoneRepo';
import { auth } from './firebase';

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
const cleanupInFlight = new Map<string, Promise<{ success: boolean; tombstone: DeletionTombstone }>>();
const CLEANUP_LEASE_MS = 5 * 60 * 1000;

let firestoreSyncEnabled = true;

export function setFirestoreSyncEnabled(enabled: boolean): void {
  firestoreSyncEnabled = enabled;
}

export function isFirestoreSyncEnabled(): boolean {
  return firestoreSyncEnabled;
}

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

  // Asynchronously queue to durable IndexedDB outbox (synchronous caller does not await)
  const outboxIntent: DurableDeletionIntent = {
    id: key,
    userId: tombstone.userId,
    taskId: tombstone.taskId,
    sessionId: tombstone.sessionId || 'all',
    entityType: 'session',
    googleCalendarEventId: tombstone.googleCalendarEventId,
    deletedAt: tombstone.deletedAt,
    status: tombstone.status,
    syncStatus: 'pending_sync',
    syncAttempts: 0,
    retryCount: tombstone.retryCount,
    lastError: tombstone.lastError,
    lastAttemptAt: tombstone.lastAttemptAt,
    updatedAt: new Date().toISOString(),
  };
  saveToOutbox(outboxIntent).then(() => {
    const currentUid = auth?.currentUser?.uid;
    if (firestoreSyncEnabled && currentUid && currentUid === tombstone.userId && currentUid !== 'user-default') {
      syncOutboxToFirestore({ userId: currentUid }).catch(() => {});
    }
  }).catch((err) => {
    console.warn('Asynchronous outbox queue notice (non-blocking call):', err);
  });

  return tombstone;
}

/**
 * Records a deletion intent for an individual session and AWAITS durable persistence in IndexedDB outbox.
 * Fails if IndexedDB outbox write fails, preventing false claims of durable persistence.
 */
export async function recordSessionDeletionDurable(
  userId: string | null | undefined,
  taskId: string,
  sessionId: string,
  googleCalendarEventId?: string
): Promise<DeletionTombstone> {
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

  // 1. Immediately update in-memory cache so sync checks in render/scheduler see it
  inMemoryTombstones.set(key, tombstone);
  saveTombstonesToStorage();

  // 2. Await durable storage in IndexedDB outbox
  const outboxIntent: DurableDeletionIntent = {
    id: key,
    userId: tombstone.userId,
    taskId: tombstone.taskId,
    sessionId: tombstone.sessionId || 'all',
    entityType: 'session',
    googleCalendarEventId: tombstone.googleCalendarEventId,
    deletedAt: tombstone.deletedAt,
    status: tombstone.status,
    syncStatus: 'pending_sync',
    syncAttempts: 0,
    retryCount: tombstone.retryCount,
    lastError: tombstone.lastError,
    lastAttemptAt: tombstone.lastAttemptAt,
    updatedAt: new Date().toISOString(),
  };

  await saveToOutbox(outboxIntent);

  // 3. Trigger background Firestore sync if user is authenticated
  const currentUid = auth?.currentUser?.uid;
  if (firestoreSyncEnabled && currentUid && currentUid === tombstone.userId && currentUid !== 'user-default') {
    syncOutboxToFirestore({ userId: currentUid }).catch(() => {});
  }

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

  // Queue task-level tombstone to durable outbox (non-blocking)
  const taskOutboxIntent: DurableDeletionIntent = {
    id: taskKey,
    userId: safeUser,
    taskId,
    sessionId: 'all',
    entityType: 'task',
    deletedAt: taskTombstone.deletedAt,
    status: taskTombstone.status,
    syncStatus: 'pending_sync',
    syncAttempts: 0,
    retryCount: 0,
    updatedAt: new Date().toISOString(),
  };
  saveToOutbox(taskOutboxIntent).then(() => {
    const currentUid = auth?.currentUser?.uid;
    if (firestoreSyncEnabled && currentUid && currentUid === safeUser && currentUid !== 'user-default') {
      syncOutboxToFirestore({ userId: currentUid }).catch(() => {});
    }
  }).catch((err) => {
    console.warn('Asynchronous outbox queue notice (non-blocking call):', err);
  });

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
 * Records a deletion intent for a whole task (and all its sessions) and AWAITS durable persistence in IndexedDB outbox.
 * Throws if durable outbox write fails.
 */
export async function recordTaskDeletionDurable(
  userId: string | null | undefined,
  taskId: string,
  sessions?: { sessionId: string; googleCalendarEventId?: string }[]
): Promise<DeletionTombstone[]> {
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

  // 2. Await task-level outbox write
  const taskOutboxIntent: DurableDeletionIntent = {
    id: taskKey,
    userId: safeUser,
    taskId,
    sessionId: 'all',
    entityType: 'task',
    deletedAt: taskTombstone.deletedAt,
    status: taskTombstone.status,
    syncStatus: 'pending_sync',
    syncAttempts: 0,
    retryCount: 0,
    updatedAt: new Date().toISOString(),
  };
  await saveToOutbox(taskOutboxIntent);

  // 3. Await session-level tombstones
  if (sessions && sessions.length > 0) {
    for (const sess of sessions) {
      const sessTombstone = await recordSessionDeletionDurable(
        safeUser,
        taskId,
        sess.sessionId,
        sess.googleCalendarEventId
      );
      tombstones.push(sessTombstone);
    }
  }

  saveTombstonesToStorage();

  // 4. Trigger background Firestore sync
  const currentUid = auth?.currentUser?.uid;
  if (firestoreSyncEnabled && currentUid && currentUid === safeUser && currentUid !== 'user-default') {
    syncOutboxToFirestore({ userId: currentUid }).catch(() => {});
  }

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

  // Asynchronously update outbox
  saveToOutbox({
    id: updated.id,
    userId: updated.userId,
    taskId: updated.taskId,
    sessionId: updated.sessionId || 'all',
    entityType: updated.sessionId && updated.sessionId !== 'all' ? 'session' : 'task',
    googleCalendarEventId: updated.googleCalendarEventId,
    deletedAt: updated.deletedAt,
    status: updated.status,
    syncStatus: 'pending_sync',
    syncAttempts: 0,
    retryCount: updated.retryCount || 0,
    lastError: updated.lastError,
    lastAttemptAt: updated.lastAttemptAt,
    updatedAt: new Date().toISOString(),
  }).catch(() => {});

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
  clearIndexedDbOutbox().catch(() => {});
}

/**
 * Initializes durable tombstone subsystem:
 * 1. Safely migrates any legacy localStorage tombstones to IndexedDB outbox.
 * 2. Hydrates in-memory tombstone cache from IndexedDB outbox.
 * 3. Reconciles authoritative Firestore tombstones if user is authenticated.
 * 4. Kicks off outbox synchronization for pending items.
 */
export async function initDurableTombstones(userId?: string): Promise<void> {
  // 1. Migrate legacy localStorage tombstones
  try {
    await migrateLocalStorageToIndexedDb();
  } catch (err) {
    console.warn('Tombstone migration notice:', err);
  }

  // 2. Hydrate from IndexedDB outbox
  try {
    const outboxItems = await getAllOutboxItems(userId);
    for (const item of outboxItems) {
      if (!inMemoryTombstones.has(item.id)) {
        inMemoryTombstones.set(item.id, {
          id: item.id,
          userId: item.userId,
          taskId: item.taskId,
          sessionId: item.sessionId === 'all' ? undefined : item.sessionId,
          googleCalendarEventId: item.googleCalendarEventId,
          deletedAt: item.deletedAt,
          status: item.status,
          retryCount: item.retryCount,
          lastError: item.lastError,
          lastAttemptAt: item.lastAttemptAt,
        });
      }
    }
  } catch (err) {
    console.warn('Failed to hydrate tombstones from outbox:', err);
  }

  // 3. Reconcile from authoritative Firestore & sync pending outbox if authenticated
  if (userId && userId !== 'user-default') {
    try {
      await reconcileRemoteTombstonesToLocal(userId);
      await syncOutboxToFirestore({ userId });
      // Reconciliation may discover a new remote ID for a tombstone already
      // cached as cleaned in this tab. Refresh memory from the reconciled outbox.
      const reconciledItems = await getAllOutboxItems(userId);
      for (const item of reconciledItems) {
        inMemoryTombstones.set(item.id, {
          id: item.id,
          userId: item.userId,
          taskId: item.taskId,
          sessionId: item.sessionId === 'all' ? undefined : item.sessionId,
          googleCalendarEventId: item.googleCalendarEventId,
          deletedAt: item.deletedAt,
          status: item.status,
          retryCount: item.retryCount,
          lastError: item.lastError,
          lastAttemptAt: item.lastAttemptAt,
        });
      }
    } catch (err) {
      console.warn('Background Firestore tombstone sync notice:', err);
    }
  }
}

export interface CompensateRemoteDeletionOptions {
  token: string;
  tombstone: DeletionTombstone;
  deleteEventFn?: (accessToken: string, googleEventId: string, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  claimCleanupFn?: (tombstone: DeletionTombstone) => Promise<
    { claimed: true; retryCount: number; lastAttemptAt: string } |
    { claimed: false; reason: 'missing' | 'cleaned' | 'busy' | 'stale_remote_id' | 'not_retryable' }
  >;
  syncStateFn?: (userId: string, tombstone: DeletionTombstone) => Promise<boolean>;
}

/**
 * Executes remote event compensation (DELETE) for a tombstoned session.
 * Idempotent: Handles 404/410 by marking as cleaned.
 */
export function compensateRemoteDeletion(
  options: CompensateRemoteDeletionOptions
): Promise<{ success: boolean; tombstone: DeletionTombstone }> {
  const active = cleanupInFlight.get(options.tombstone.id);
  if (active) return active;

  const operation = runRemoteDeletionCompensation(options).finally(() => {
    if (cleanupInFlight.get(options.tombstone.id) === operation) {
      cleanupInFlight.delete(options.tombstone.id);
    }
  });
  cleanupInFlight.set(options.tombstone.id, operation);
  return operation;
}

async function runRemoteDeletionCompensation(
  options: CompensateRemoteDeletionOptions
): Promise<{ success: boolean; tombstone: DeletionTombstone }> {
  const { token, tombstone, deleteEventFn = deleteGoogleCalendarEvent, signal } = options;
  let current = inMemoryTombstones.get(tombstone.id) || tombstone;
  if (!current.googleCalendarEventId) {
    return { success: current.status === 'cleaned', tombstone: current };
  }
  if (!token?.trim() || signal?.aborted) return { success: false, tombstone: current };
  if (current.googleCalendarEventId !== tombstone.googleCalendarEventId) {
    return { success: false, tombstone: current };
  }
  if (current.status === 'cleaned' && (current.userId === 'user-default' || options.claimCleanupFn)) {
    return { success: true, tombstone: current };
  }

  const userId = current.userId;
  let retryCount = current.retryCount || 0;
  let lastAttemptAt = new Date().toISOString();

  try {
    if (userId !== 'user-default' && !options.claimCleanupFn) {
      // Reconcile first so a new remote ID or cleaned state from another device
      // cannot be overwritten by a stale local outbox snapshot.
      await reconcileRemoteTombstonesToLocal(userId);
      const reconciled = await getOutboxItem(current.id);
      if (reconciled?.syncStatus === 'synced') {
        current = {
          id: reconciled.id,
          userId: reconciled.userId,
          taskId: reconciled.taskId,
          sessionId: reconciled.sessionId === 'all' ? undefined : reconciled.sessionId,
          googleCalendarEventId: reconciled.googleCalendarEventId,
          deletedAt: reconciled.deletedAt,
          status: reconciled.status,
          retryCount: reconciled.retryCount,
          lastError: reconciled.lastError,
          lastAttemptAt: reconciled.lastAttemptAt,
        };
        inMemoryTombstones.set(current.id, current);
        if (current.googleCalendarEventId !== tombstone.googleCalendarEventId) {
          return { success: false, tombstone: current };
        }
        if (current.status === 'cleaned') return { success: true, tombstone: current };
      }
      // Ensure the durable local intent has reached Firestore before taking a remote action.
      await syncOutboxToFirestore({ userId });
    }

    if (options.claimCleanupFn) {
      const claim = await options.claimCleanupFn(current);
      if (!claim.claimed) {
        const latest = inMemoryTombstones.get(current.id) || current;
        return { success: claim.reason === 'cleaned', tombstone: latest };
      }
      retryCount = claim.retryCount;
      lastAttemptAt = claim.lastAttemptAt;
    } else if (userId !== 'user-default') {
      const intent: DurableDeletionIntent = {
        id: current.id,
        userId,
        taskId: current.taskId,
        sessionId: current.sessionId || 'all',
        entityType: current.sessionId && current.sessionId !== 'all' ? 'session' : 'task',
        googleCalendarEventId: current.googleCalendarEventId,
        deletedAt: current.deletedAt,
        status: current.status,
        syncStatus: 'synced',
        syncAttempts: 0,
        retryCount,
        lastError: current.lastError,
        lastAttemptAt: current.lastAttemptAt,
        updatedAt: new Date().toISOString(),
      };
      const claim = await claimAuthoritativeRemoteCleanup(intent, { leaseMs: CLEANUP_LEASE_MS });
      if (!claim.claimed) {
        const latest = inMemoryTombstones.get(current.id) || current;
        return { success: claim.reason === 'cleaned', tombstone: latest };
      }
      retryCount = claim.tombstone.retryCount;
      lastAttemptAt = claim.tombstone.lastAttemptAt || lastAttemptAt;
    } else {
      if (current.status === 'cleaning') {
        const lastAttempt = current.lastAttemptAt ? Date.parse(current.lastAttemptAt) : NaN;
        if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < CLEANUP_LEASE_MS) {
          return { success: false, tombstone: current };
        }
      } else if (current.status !== 'pending_cleanup' && current.status !== 'cleanup_failed') {
        return { success: false, tombstone: current };
      }
      retryCount += 1;
    }

    // Persist the claimed state in IndexedDB before issuing DELETE.
    const claimedTombstone: DeletionTombstone = {
      ...current,
      status: 'cleaning',
      retryCount,
      lastAttemptAt,
      lastError: undefined,
    };
    await saveToOutbox(toDurableIntent(claimedTombstone, 'synced'));
    const latestBeforeDelete = inMemoryTombstones.get(current.id) || current;
    if (latestBeforeDelete.googleCalendarEventId !== current.googleCalendarEventId) {
      return { success: false, tombstone: latestBeforeDelete };
    }
    if (latestBeforeDelete.status === 'cleaned') {
      return { success: true, tombstone: latestBeforeDelete };
    }
    inMemoryTombstones.set(current.id, claimedTombstone);
    saveTombstonesToStorage();

    try {
      await deleteEventFn(token, current.googleCalendarEventId, signal);
    } catch (err: any) {
      const status = err?.status || err?.classification?.status;
      if (status !== 404 && status !== 410) {
        return await finishCleanupAttempt(options, claimedTombstone, {
          status: 'cleanup_failed',
          lastError: describeCleanupFailure(err),
          lastAttemptAt,
        });
      }
    }

    return await finishCleanupAttempt(options, claimedTombstone, {
      status: 'cleaned',
      lastError: undefined,
      lastAttemptAt,
    });
  } catch (err: any) {
    const latest = inMemoryTombstones.get(current.id) || current;
    return { success: false, tombstone: latest };
  }
}

function describeCleanupFailure(err: any): string {
  const status = err?.status || err?.classification?.status || 0;
  const code = err?.code || err?.classification?.code;
  const category = status === 401
    ? 'AUTHENTICATION'
    : status === 403
      ? 'PERMISSION'
      : status === 0
        ? 'NETWORK_OR_ABORT'
        : status >= 500 || status === 429
          ? 'TRANSIENT_SERVICE'
          : 'REMOTE_FAILURE';
  const detail = err?.message || 'Remote DELETE failed';
  return `[${category}${code ? `/${code}` : ''}${status ? ` HTTP ${status}` : ''}] ${detail}`;
}

function toDurableIntent(
  tombstone: DeletionTombstone,
  syncStatus: DurableDeletionIntent['syncStatus']
): DurableDeletionIntent {
  return {
    id: tombstone.id,
    userId: tombstone.userId,
    taskId: tombstone.taskId,
    sessionId: tombstone.sessionId || 'all',
    entityType: tombstone.sessionId && tombstone.sessionId !== 'all' ? 'session' : 'task',
    googleCalendarEventId: tombstone.googleCalendarEventId,
    deletedAt: tombstone.deletedAt,
    status: tombstone.status,
    syncStatus,
    syncAttempts: 0,
    retryCount: tombstone.retryCount || 0,
    lastError: tombstone.lastError,
    lastAttemptAt: tombstone.lastAttemptAt,
    updatedAt: new Date().toISOString(),
  };
}

async function finishCleanupAttempt(
  options: CompensateRemoteDeletionOptions,
  claimedTombstone: DeletionTombstone,
  patch: Pick<DeletionTombstone, 'status' | 'lastError' | 'lastAttemptAt'>
): Promise<{ success: boolean; tombstone: DeletionTombstone }> {
  const current = inMemoryTombstones.get(claimedTombstone.id) || claimedTombstone;
  if (current.googleCalendarEventId !== claimedTombstone.googleCalendarEventId) {
    return { success: false, tombstone: current };
  }
  if (current.status === 'cleaned') return { success: true, tombstone: current };

  const next = { ...current, ...patch };
  await saveToOutbox(toDurableIntent(next, 'pending_sync'));
  let confirmed = options.syncStateFn
    ? await options.syncStateFn(next.userId, next)
    : next.userId === 'user-default';

  if (!options.syncStateFn && next.userId !== 'user-default') {
    const sync = await syncOutboxToFirestore({ userId: next.userId });
    const outbox = await getOutboxItem(next.id);
    confirmed = sync.failedCount === 0 && outbox?.syncStatus === 'synced' && outbox.status === next.status;
  }

  if (!confirmed) return { success: false, tombstone: current };
  const latest = inMemoryTombstones.get(next.id) || current;
  if (latest.googleCalendarEventId !== claimedTombstone.googleCalendarEventId) {
    return { success: false, tombstone: latest };
  }
  inMemoryTombstones.set(next.id, next);
  saveTombstonesToStorage();
  return { success: patch.status === 'cleaned', tombstone: next };
}

export interface ProcessPendingCleanupsOptions {
  token: string;
  userId?: string;
  deleteEventFn?: (accessToken: string, googleEventId: string, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  claimCleanupFn?: CompensateRemoteDeletionOptions['claimCleanupFn'];
  syncStateFn?: CompensateRemoteDeletionOptions['syncStateFn'];
  now?: number;
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
  if (userId && userId !== 'user-default' && !options.claimCleanupFn) {
    await initDurableTombstones(userId);
  }
  const tombstones = getTombstones(userId);

  const now = options.now ?? Date.now();
  const pending = tombstones.filter(
    (t) =>
      (t.status === 'pending_cleanup' || t.status === 'cleanup_failed' || t.status === 'cleaning') &&
      Boolean(t.googleCalendarEventId) &&
      isCleanupDue(t, now)
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
      claimCleanupFn: options.claimCleanupFn,
      syncStateFn: options.syncStateFn,
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

function cleanupRetryDelayMs(retryCount: number): number {
  const attemptExponent = Math.max(0, Math.min(16, (retryCount || 0) - 1));
  return Math.min(6 * 60 * 60 * 1000, 5_000 * 2 ** attemptExponent);
}

function isCleanupDue(tombstone: DeletionTombstone, now: number): boolean {
  if (!tombstone.lastAttemptAt) return true;
  const lastAttempt = Date.parse(tombstone.lastAttemptAt);
  if (!Number.isFinite(lastAttempt)) return true;
  const delay = tombstone.status === 'cleaning'
    ? CLEANUP_LEASE_MS
    : cleanupRetryDelayMs(tombstone.retryCount);
  return now - lastAttempt >= delay;
}

// Automatically load tombstones on module initialization
loadTombstonesFromStorage();
