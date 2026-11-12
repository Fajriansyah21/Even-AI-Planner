/**
 * Authoritative Firestore Deletion Tombstone Repository & Outbox Synchronization Service
 *
 * Implements cross-device authoritative truth for deletion intents in Firestore.
 * Subcollection: /users/{userId}/deletion_tombstones/{tombstoneId}
 * Enforces ownership validation, transaction-based monotonic tombstone merges, and idempotent outbox sync.
 * Conforms to Phase 2A.3.4.4 review hardening.
 */

import {
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection,
  runTransaction,
  Transaction,
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
import { sha256Hex } from './sha256';

export interface FirestoreTombstoneDoc {
  id: string; // Deterministic collision-resistant Document ID
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

function decodeFirestoreTombstone(
  data: Record<string, any>,
  documentId: string
): FirestoreTombstoneDoc {
  return {
    ...data,
    id: documentId,
    lastError: data.lastError ?? data.error ?? null,
  } as FirestoreTombstoneDoc;
}

function encodeFirestoreTombstone(tombstone: FirestoreTombstoneDoc): Record<string, unknown> {
  // Keep the wire schema aligned with firestore.rules (Step 3 contract).
  return {
    compositeKey: tombstone.compositeKey,
    userId: tombstone.userId,
    taskId: tombstone.taskId,
    sessionId: tombstone.sessionId,
    entityType: tombstone.entityType,
    googleCalendarEventId: tombstone.googleCalendarEventId ?? null,
    deletedAt: tombstone.deletedAt,
    status: tombstone.status,
    retryCount: tombstone.retryCount,
    updatedAt: tombstone.updatedAt,
    lastAttemptAt: tombstone.lastAttemptAt ?? null,
    error: tombstone.lastError ?? null,
  };
}

/**
 * Builds standard collision-resistant Firestore document ID conforming to isValidId rule: ^[a-zA-Z0-9_\-]+$
 * Uses SHA-256 hash over canonical un-truncated (taskId\0sessionId) to prevent collisions.
 * Max length is strictly guaranteed under 128 characters.
 */
export function buildFirestoreTombstoneDocId(taskId: string, sessionId?: string): string {
  const safeSession = sessionId && sessionId.trim() ? sessionId.trim() : 'all';
  const canonicalKey = `${taskId}\0${safeSession}`;
  const hash = sha256Hex(canonicalKey); // 64 hex characters

  const safeTaskPrefix = sanitizeIdForFirestore(taskId).slice(0, 32);
  const safeSessionPrefix = sanitizeIdForFirestore(safeSession).slice(0, 16);
  // tomb_ (5) + task (<=32) + _ (1) + sess (<=16) + _ (1) + hash32 (32) = max 87 chars <= 128 chars
  const docId = `tomb_${safeTaskPrefix}_${safeSessionPrefix}_${hash.slice(0, 32)}`;
  return docId;
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
  customRunTransaction?: (
    firestoreDb: typeof db,
    updateFunction: (transaction: Transaction) => Promise<any>
  ) => Promise<any>;
}

export type RemoteCleanupClaimResult =
  | { claimed: true; tombstone: FirestoreTombstoneDoc }
  | { claimed: false; reason: 'missing' | 'cleaned' | 'busy' | 'stale_remote_id' | 'not_retryable' };

export interface ClaimRemoteCleanupOptions {
  now?: Date;
  leaseMs?: number;
  customRunTransaction?: (
    firestoreDb: typeof db,
    updateFunction: (transaction: Transaction) => Promise<any>
  ) => Promise<any>;
}

/**
 * Atomically claims one exact remote event for cleanup. Firestore transaction
 * serialization makes the pending -> cleaning transition exclusive across tabs
 * and devices. `lastAttemptAt` is the lease clock because Step 3's schema does
 * not include a separate lease field.
 */
export async function claimAuthoritativeRemoteCleanup(
  tombstone: DurableDeletionIntent,
  options: ClaimRemoteCleanupOptions = {}
): Promise<RemoteCleanupClaimResult> {
  validateUserOwnership(tombstone.userId);
  const docId = buildFirestoreTombstoneDocId(tombstone.taskId, tombstone.sessionId);
  const docRef = doc(db, 'users', tombstone.userId, 'deletion_tombstones', docId);
  const txRunner = options.customRunTransaction || runTransaction;
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  const leaseMs = options.leaseMs ?? 5 * 60 * 1000;

  return txRunner(db, async (transaction) => {
    const snap = await transaction.get(docRef);
    if (!snap.exists()) return { claimed: false, reason: 'missing' } as const;
    const existing = decodeFirestoreTombstone(snap.data(), docId);

    if (existing.googleCalendarEventId !== tombstone.googleCalendarEventId) {
      return { claimed: false, reason: 'stale_remote_id' } as const;
    }
    if (existing.status === 'cleaned') {
      return { claimed: false, reason: 'cleaned' } as const;
    }
    if (existing.status === 'cleaning') {
      const lastAttempt = existing.lastAttemptAt ? Date.parse(existing.lastAttemptAt) : NaN;
      if (Number.isFinite(lastAttempt) && now.getTime() - lastAttempt < leaseMs) {
        return { claimed: false, reason: 'busy' } as const;
      }
    } else if (existing.status !== 'pending_cleanup' && existing.status !== 'cleanup_failed') {
      return { claimed: false, reason: 'not_retryable' } as const;
    }

    const claimed: FirestoreTombstoneDoc = {
      ...existing,
      status: 'cleaning',
      retryCount: (existing.retryCount || 0) + 1,
      lastAttemptAt: nowIso,
      lastError: null,
      updatedAt: nowIso,
    };
    transaction.set(docRef, sanitizeForFirestore(encodeFirestoreTombstone(claimed)));
    return { claimed: true, tombstone: claimed } as const;
  });
}

/**
 * Authoritatively saves or merges a deletion tombstone into Firestore using an atomic transaction.
 * Monotonic:
 * 1. Reads existing tombstone within transaction (fails immediately if read throws).
 * 2. Preserves earliest valid deletedAt.
 * 3. Never downgrades 'cleaned' to 'pending_cleanup' unless a new, uncleaned remote ID arrived.
 * 4. Ensures concurrent writes resolve deterministically without lost updates.
 */
export async function saveAuthoritativeTombstone(
  tombstone: DurableDeletionIntent,
  options?: SaveFirestoreTombstoneOptions
): Promise<FirestoreTombstoneDoc> {
  const { userId, taskId, sessionId } = tombstone;
  validateUserOwnership(userId);

  const docId = buildFirestoreTombstoneDocId(taskId, sessionId);
  const docRef = doc(db, 'users', userId, 'deletion_tombstones', docId);

  const txRunner = options?.customRunTransaction || runTransaction;

  try {
    const resultDoc = await txRunner(db, async (transaction) => {
      // 1. Transactional read - if this throws (e.g. offline / permission), transaction aborts
      const snap = await transaction.get(docRef);
      const existingData = snap.exists()
        ? decodeFirestoreTombstone(snap.data(), docId)
        : undefined;

      // 2. Monotonic resolution rules
      let finalDeletedAt = tombstone.deletedAt;
      let finalRemoteId = tombstone.googleCalendarEventId || existingData?.googleCalendarEventId || null;
      let finalStatus = tombstone.status;
      let finalRetryCount = tombstone.retryCount || 0;
      let finalLastError = tombstone.lastError || null;
      let finalLastAttemptAt = tombstone.lastAttemptAt || null;

      if (existingData) {
        // Retry attempts are claimed atomically before DELETE. A stale outbox
        // snapshot must never lower that authoritative counter.
        finalRetryCount = Math.max(finalRetryCount, existingData.retryCount || 0);
        // Enforce earliest deletedAt
        const existingTime = new Date(existingData.deletedAt).getTime();
        const incomingTime = new Date(tombstone.deletedAt).getTime();
        if (!isNaN(existingTime) && !isNaN(incomingTime) && existingTime < incomingTime) {
          finalDeletedAt = existingData.deletedAt;
        }

        // Remote ID & Status Monotonicity:
        const remoteIdDiffers =
          Boolean(tombstone.googleCalendarEventId) &&
          tombstone.googleCalendarEventId !== existingData.googleCalendarEventId;
        const firstRemoteIdArrival =
          !existingData.googleCalendarEventId &&
          Boolean(tombstone.googleCalendarEventId) &&
          existingData.status === 'pending_cleanup' &&
          tombstone.status === 'pending_cleanup';
        const existingUpdatedAt = Date.parse(existingData.updatedAt);
        const incomingUpdatedAt = Date.parse(tombstone.updatedAt);
        const newerRemoteIdAfterCleanup =
          existingData.status === 'cleaned' &&
          tombstone.status === 'pending_cleanup' &&
          remoteIdDiffers &&
          Number.isFinite(incomingUpdatedAt) &&
          Number.isFinite(existingUpdatedAt) &&
          incomingUpdatedAt > existingUpdatedAt;
        const hasNewRemoteId = firstRemoteIdArrival || newerRemoteIdAfterCleanup;

        if (hasNewRemoteId) {
          // A delayed POST completed and created an event remotely: MUST transition to pending_cleanup for compensation
          finalRemoteId = tombstone.googleCalendarEventId;
          finalStatus = 'pending_cleanup';
        } else if (remoteIdDiffers) {
          // A stale or illegal ID change must not replace the current remote identity.
          finalRemoteId = existingData.googleCalendarEventId || null;
          finalStatus = existingData.status;
          finalRetryCount = Math.max(finalRetryCount, existingData.retryCount || 0);
        } else {
          // If already cleaned, retain cleaned status unless a new remote ID arrived
          if (existingData.status === 'cleaned') {
            finalStatus = 'cleaned';
          } else if (existingData.status === 'cleaning' && tombstone.status === 'pending_cleanup') {
            finalStatus = 'cleaning';
          } else if (tombstone.status === 'cleaned') {
            finalStatus = 'cleaned';
          } else if (tombstone.status === 'cleanup_failed') {
            finalStatus = 'cleanup_failed';
            finalRetryCount = Math.max(tombstone.retryCount || 0, existingData.retryCount || 0);
            finalLastError = tombstone.lastError || existingData.lastError || null;
            finalLastAttemptAt = tombstone.lastAttemptAt || new Date().toISOString();
          }
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
        retryCount: finalRetryCount,
        lastError: finalLastError,
        lastAttemptAt: finalLastAttemptAt,
        syncedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 3. Transactional write
      transaction.set(docRef, sanitizeForFirestore(encodeFirestoreTombstone(firestoreData)));
      return firestoreData;
    });

    return resultDoc;
  } catch (err) {
    handleFirestoreError(
      err,
      OperationType.WRITE,
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
        results.push(decodeFirestoreTombstone(docSnap.data(), docSnap.id));
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
