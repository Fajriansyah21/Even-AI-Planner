/**
 * Authoritative Firestore Deletion Tombstone Repository & Outbox Synchronization Service
 *
 * Implements cross-device authoritative truth for deletion intents in Firestore.
 * Subcollection: /users/{userId}/deletion_tombstones/{tombstoneId}
 * Enforces ownership validation, monotonic tombstone merges, and idempotent outbox sync.
 * Conforms to Phase 2A.3.4.4 architectural requirements.
 */

import {
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import { db, auth, sanitizeForFirestore, handleFirestoreError, OperationType } from './firebase';
import {
  DurableDeletionIntent,
  getPendingSyncOutboxItems,
  markOutboxItemSynced,
  updateOutboxItemSyncFailure,
  sanitizeIdForFirestore,
  buildOutboxKey,
  saveToOutbox,
} from './indexedDbOutbox';

export interface FirestoreTombstoneDoc {
  id: string; // Document ID: `${sanitizedTaskId}_${sanitizedSessionId}`
  compositeKey: string; // Original composite key: `${userId}:${taskId}:${sessionId}`
  userId: string;
  taskId: string;
  sessionId: string; // 'all' if whole task
  entityType: 'task' | 'session';
  googleCalendarEventId?: string | null;
  deletedAt: string; // ISO 8601 string
  status: 'pending_cleanup' | 'cleaning' | 'cleaned' | 'cleanup_failed';
  retryCount: number;
  lastError?: string | null;
  lastAttemptAt?: string | null;
  syncedAt?: string;
  updatedAt: string;
}

/**
 * Builds standard Firestore document ID conforming to isValidId rule: ^[a-zA-Z0-9_\-]+$
 */
export function buildFirestoreTombstoneDocId(taskId: string, sessionId?: string): string {
  const safeTask = sanitizeIdForFirestore(taskId);
  const safeSession = sanitizeIdForFirestore(sessionId || 'all');
  const docId = `tomb_${safeTask}_${safeSession}`;
  // Enforce 128 character max size from firestore.rules
  return docId.length > 128 ? docId.substring(0, 128) : docId;
}

/**
 * Validates that the current user owns the specified userId data
 */
export function validateUserOwnership(userId: string): void {
  const currentUid = auth.currentUser?.uid;
  if (!currentUid) {
    throw new Error('Operasi Firestore ditolak: Pengguna belum terautentikasi');
  }
  if (currentUid !== userId) {
    throw new Error(
      `Operasi Firestore ditolak: User ID "${userId}" tidak cocok dengan akun terautentikasi "${currentUid}"`
    );
  }
}

export interface SaveFirestoreTombstoneOptions {
  customSetDoc?: typeof setDoc;
  customGetDoc?: typeof getDoc;
}

/**
 * Authoritatively saves or merges a deletion tombstone into Firestore.
 * Monotonic: Prevents older records from overwriting newer deletion decisions.
 */
export async function saveAuthoritativeTombstone(
  tombstone: DurableDeletionIntent,
  options?: SaveFirestoreTombstoneOptions
): Promise<FirestoreTombstoneDoc> {
  const { userId, taskId, sessionId } = tombstone;
  validateUserOwnership(userId);

  const docId = buildFirestoreTombstoneDocId(taskId, sessionId);
  const docRef = doc(db, 'users', userId, 'deletion_tombstones', docId);

  const setFn = options?.customSetDoc || setDoc;
  const getFn = options?.customGetDoc || getDoc;

  // Check existing document to ensure monotonic merge
  let existingData: FirestoreTombstoneDoc | undefined;
  try {
    const existingSnap = await getFn(docRef);
    if (existingSnap.exists()) {
      existingData = existingSnap.data() as FirestoreTombstoneDoc;
    }
  } catch (err) {
    // If read fails (e.g. offline or new doc), proceed with fresh upsert
  }

  // Monotonic resolution:
  // If existing record has newer or equal deletedAt, and is already cleaned, preserve cleaned status
  let finalStatus = tombstone.status;
  let finalRemoteId = tombstone.googleCalendarEventId || existingData?.googleCalendarEventId || null;
  let finalDeletedAt = tombstone.deletedAt;

  if (existingData) {
    const existingTime = new Date(existingData.deletedAt).getTime();
    const incomingTime = new Date(tombstone.deletedAt).getTime();

    // Use earliest deletedAt to respect first deletion decision
    if (!isNaN(existingTime) && !isNaN(incomingTime) && existingTime < incomingTime) {
      finalDeletedAt = existingData.deletedAt;
    }

    // Never downgrade 'cleaned' to 'pending_cleanup' unless a new remote ID was introduced
    if (existingData.status === 'cleaned' && (!finalRemoteId || finalRemoteId === existingData.googleCalendarEventId)) {
      finalStatus = 'cleaned';
    }
  }

  const firestoreData: FirestoreTombstoneDoc = {
    id: docId,
    compositeKey: tombstone.id || buildOutboxKey(userId, taskId, sessionId),
    userId,
    taskId,
    sessionId: sessionId || 'all',
    entityType: tombstone.entityType || (sessionId && sessionId !== 'all' ? 'session' : 'task'),
    googleCalendarEventId: finalRemoteId,
    deletedAt: finalDeletedAt,
    status: finalStatus,
    retryCount: tombstone.retryCount || 0,
    lastError: tombstone.lastError || null,
    lastAttemptAt: tombstone.lastAttemptAt || null,
    syncedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await setFn(docRef, sanitizeForFirestore(firestoreData));
    return firestoreData;
  } catch (err) {
    handleFirestoreError(
      err,
      OperationType.CREATE,
      `users/${userId}/deletion_tombstones/${docId}`
    );
    throw err;
  }
}

export interface GetAuthoritativeTombstonesOptions {
  customGetDocs?: typeof getDocs;
}

/**
 * Fetches all authoritative tombstones for an authenticated user from Firestore.
 * Used during application startup or cross-device reconciliation.
 */
export async function getAuthoritativeTombstones(
  userId: string,
  options?: GetAuthoritativeTombstonesOptions
): Promise<FirestoreTombstoneDoc[]> {
  validateUserOwnership(userId);

  const colRef = collection(db, 'users', userId, 'deletion_tombstones');
  const getDocsFn = options?.customGetDocs || getDocs;

  try {
    const snapshot = await getDocsFn(colRef);
    const results: FirestoreTombstoneDoc[] = [];
    snapshot.forEach((docSnap) => {
      if (docSnap.exists()) {
        results.push(docSnap.data() as FirestoreTombstoneDoc);
      }
    });
    return results;
  } catch (err) {
    handleFirestoreError(
      err,
      OperationType.LIST,
      `users/${userId}/deletion_tombstones`
    );
    throw err;
  }
}

export interface SyncOutboxOptions {
  userId: string;
  batchSize?: number;
  saveAuthoritativeFn?: (intent: DurableDeletionIntent) => Promise<FirestoreTombstoneDoc>;
}

/**
 * Synchronizes pending deletion intents from IndexedDB Outbox to Firestore.
 * Offline-first: Items remain in outbox until Firestore confirms successful write.
 * Idempotent: Can be called multiple times, on focus, or upon reconnection.
 */
export async function syncOutboxToFirestore(options: SyncOutboxOptions): Promise<{
  totalPending: number;
  syncedCount: number;
  failedCount: number;
  errors: string[];
}> {
  const { userId, batchSize = 50, saveAuthoritativeFn = saveAuthoritativeTombstone } = options;

  validateUserOwnership(userId);

  const pendingItems = await getPendingSyncOutboxItems(userId);
  const itemsToProcess = pendingItems.slice(0, batchSize);

  let syncedCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const item of itemsToProcess) {
    try {
      // 1. Send tombstone to authoritative Firestore repository
      await saveAuthoritativeFn(item);

      // 2. Mark item as synced in durable IndexedDB outbox
      await markOutboxItemSynced(item.id);
      syncedCount++;
    } catch (err: any) {
      failedCount++;
      const errMsg = err?.message || String(err);
      errors.push(`Gagal menyinkronkan tombstone ${item.id}: ${errMsg}`);

      // 3. Record failure metadata in outbox without deleting the item
      await updateOutboxItemSyncFailure(item.id, errMsg).catch(() => {});
    }
  }

  return {
    totalPending: pendingItems.length,
    syncedCount,
    failedCount,
    errors,
  };
}

/**
 * Reconciles authoritative Firestore tombstones into local IndexedDB and in-memory cache.
 * Ensures cross-device deletion decisions propagate to current device.
 */
export async function reconcileRemoteTombstonesToLocal(
  userId: string,
  options?: GetAuthoritativeTombstonesOptions
): Promise<{ reconciledCount: number }> {
  validateUserOwnership(userId);

  const remoteTombstones = await getAuthoritativeTombstones(userId, options);
  let reconciledCount = 0;

  for (const remote of remoteTombstones) {
    const compositeKey = remote.compositeKey || buildOutboxKey(userId, remote.taskId, remote.sessionId);

    const localIntent: DurableDeletionIntent = {
      id: compositeKey,
      userId: remote.userId,
      taskId: remote.taskId,
      sessionId: remote.sessionId || 'all',
      entityType: remote.entityType || 'task',
      googleCalendarEventId: remote.googleCalendarEventId || undefined,
      deletedAt: remote.deletedAt,
      status: remote.status,
      syncStatus: 'synced',
      syncAttempts: 0,
      retryCount: remote.retryCount || 0,
      lastError: remote.lastError || undefined,
      lastAttemptAt: remote.lastAttemptAt || undefined,
      updatedAt: remote.updatedAt || new Date().toISOString(),
    };

    await saveToOutbox(localIntent);
    reconciledCount++;
  }

  return { reconciledCount };
}
