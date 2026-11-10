/**
 * Durable IndexedDB Deletion Outbox
 *
 * Implements offline-first durable local storage for deletion intents.
 * Acts as an outbox until deletion tombstones are authoritatively acknowledged by Firestore.
 * Conforms to Phase 2A.3.4.4 architectural requirements.
 */

export type OutboxSyncStatus = 'pending_sync' | 'synced' | 'sync_failed';

export interface DurableDeletionIntent {
  /** Deterministic composite key: `${userId}:${taskId}:${sessionId || 'all'}` */
  id: string;
  userId: string;
  taskId: string;
  sessionId: string; // 'all' if whole task
  entityType: 'task' | 'session';
  googleCalendarEventId?: string;
  deletedAt: string; // ISO 8601 string
  status: 'pending_cleanup' | 'cleaning' | 'cleaned' | 'cleanup_failed';
  syncStatus: OutboxSyncStatus;
  syncAttempts: number;
  lastSyncAttemptAt?: string;
  syncError?: string;
  retryCount: number;
  lastError?: string;
  lastAttemptAt?: string;
  updatedAt: string; // ISO 8601 string
}

export const DB_NAME = 'even_planner_db';
export const DB_VERSION = 1;
export const OUTBOX_STORE = 'deletion_outbox';
export const LEGACY_STORAGE_KEY = 'even_deletion_tombstones_v1';

// In-memory fallback store for Node.js / SSR / non-IndexedDB test environments
const inMemoryStore = new Map<string, DurableDeletionIntent>();
let isUsingMemoryFallback = false;

/**
 * Builds deterministic composite key for outbox items
 */
export function buildOutboxKey(
  userId: string | null | undefined,
  taskId: string,
  sessionId?: string
): string {
  const safeUser = userId && userId.trim() ? userId : 'user-default';
  const safeSession = sessionId && sessionId.trim() ? sessionId : 'all';
  return `${safeUser}:${taskId}:${safeSession}`;
}

/**
 * Sanitizes an ID to be safe for Firestore document paths (must match ^[a-zA-Z0-9_\-]+$)
 */
export function sanitizeIdForFirestore(rawId: string): string {
  return rawId.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

/**
 * Detects if native IndexedDB is available
 */
function getIndexedDbInstance(): IDBFactory | null {
  if (typeof globalThis !== 'undefined' && globalThis.indexedDB) {
    return globalThis.indexedDB;
  }
  if (typeof window !== 'undefined' && window.indexedDB) {
    return window.indexedDB;
  }
  return null;
}

/**
 * Opens connection to IndexedDB database with schema versioning
 */
export function openOutboxDatabase(): Promise<IDBDatabase> {
  const idb = getIndexedDbInstance();
  if (!idb) {
    isUsingMemoryFallback = true;
    return Promise.reject(new Error('IndexedDB not supported in current environment'));
  }

  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
        store.createIndex('by_userId', 'userId', { unique: false });
        store.createIndex('by_syncStatus', 'syncStatus', { unique: false });
        store.createIndex('by_deletedAt', 'deletedAt', { unique: false });
        store.createIndex('by_user_syncStatus', ['userId', 'syncStatus'], { unique: false });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB database'));
    };

    request.onblocked = () => {
      console.warn('IndexedDB database upgrade blocked by active connection');
    };
  });
}

/**
 * Persists a deletion intent durably into IndexedDB Outbox.
 * Guarantees transaction completion before resolving.
 */
export async function saveToOutbox(intent: DurableDeletionIntent): Promise<void> {
  try {
    const db = await openOutboxDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      const store = tx.objectStore(OUTBOX_STORE);

      store.put(intent);

      tx.oncomplete = () => {
        // Also keep memory cache aligned
        inMemoryStore.set(intent.id, intent);
        db.close();
        resolve();
      };

      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('Transaction failed in saveToOutbox'));
      };

      tx.onabort = () => {
        db.close();
        reject(new Error('Transaction aborted in saveToOutbox'));
      };
    });
  } catch (err) {
    // If IndexedDB unavailable, use in-memory fallback
    inMemoryStore.set(intent.id, intent);
    if (!isUsingMemoryFallback) {
      console.warn('Fallback to in-memory store for saveToOutbox:', err);
    }
  }
}

/**
 * Retrieves a single outbox item by its composite key
 */
export async function getOutboxItem(id: string): Promise<DurableDeletionIntent | undefined> {
  try {
    const db = await openOutboxDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readonly');
      const store = tx.objectStore(OUTBOX_STORE);
      const req = store.get(id);

      req.onsuccess = () => {
        db.close();
        resolve(req.result || undefined);
      };

      req.onerror = () => {
        db.close();
        reject(req.error || new Error('Failed to get outbox item'));
      };
    });
  } catch {
    return inMemoryStore.get(id);
  }
}

/**
 * Retrieves all deletion intents from the outbox, optionally filtered by user ID
 */
export async function getAllOutboxItems(userId?: string): Promise<DurableDeletionIntent[]> {
  try {
    const db = await openOutboxDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readonly');
      const store = tx.objectStore(OUTBOX_STORE);

      let req: IDBRequest<any>;
      if (userId) {
        const index = store.index('by_userId');
        req = index.getAll(userId);
      } else {
        req = store.getAll();
      }

      req.onsuccess = () => {
        db.close();
        resolve(req.result || []);
      };

      req.onerror = () => {
        db.close();
        reject(req.error || new Error('Failed to get all outbox items'));
      };
    });
  } catch {
    const all = Array.from(inMemoryStore.values());
    if (userId) {
      return all.filter((item) => item.userId === userId);
    }
    return all;
  }
}

/**
 * Retrieves all outbox items that require synchronization to Firestore
 */
export async function getPendingSyncOutboxItems(userId?: string): Promise<DurableDeletionIntent[]> {
  try {
    const db = await openOutboxDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readonly');
      const store = tx.objectStore(OUTBOX_STORE);

      let req: IDBRequest<any>;
      if (userId) {
        const index = store.index('by_user_syncStatus');
        req = index.getAll(IDBKeyRange.only([userId, 'pending_sync']));
      } else {
        const index = store.index('by_syncStatus');
        req = index.getAll('pending_sync');
      }

      req.onsuccess = () => {
        db.close();
        const results: DurableDeletionIntent[] = req.result || [];
        resolve(results);
      };

      req.onerror = () => {
        db.close();
        reject(req.error || new Error('Failed to get pending sync outbox items'));
      };
    });
  } catch {
    return Array.from(inMemoryStore.values()).filter(
      (item) => item.syncStatus === 'pending_sync' && (!userId || item.userId === userId)
    );
  }
}

/**
 * Marks an outbox item as synchronized after Firestore confirmation.
 * Does NOT delete immediately so that local monotonic checks still find it,
 * but updates syncStatus to 'synced'.
 */
export async function markOutboxItemSynced(id: string): Promise<void> {
  const existing = await getOutboxItem(id);
  if (!existing) return;

  const updated: DurableDeletionIntent = {
    ...existing,
    syncStatus: 'synced',
    syncError: undefined,
    updatedAt: new Date().toISOString(),
  };

  await saveToOutbox(updated);
}

/**
 * Records synchronization failure for an outbox item
 */
export async function updateOutboxItemSyncFailure(id: string, error: string): Promise<void> {
  const existing = await getOutboxItem(id);
  if (!existing) return;

  const updated: DurableDeletionIntent = {
    ...existing,
    syncStatus: 'sync_failed',
    syncAttempts: (existing.syncAttempts || 0) + 1,
    syncError: error,
    lastSyncAttemptAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveToOutbox(updated);
}

/**
 * Safely removes an outbox item once Firestore confirms authoritative persistence
 * and remote cleanup is completed.
 */
export async function removeConfirmedOutboxItem(id: string): Promise<void> {
  try {
    const db = await openOutboxDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      const store = tx.objectStore(OUTBOX_STORE);

      store.delete(id);

      tx.oncomplete = () => {
        inMemoryStore.delete(id);
        db.close();
        resolve();
      };

      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('Failed to delete outbox item'));
      };
    });
  } catch {
    inMemoryStore.delete(id);
  }
}

/**
 * Migrates legacy localStorage tombstones to IndexedDB outbox.
 * Idempotent: Does not remove localStorage item until IndexedDB write is confirmed.
 * If migration fails midway, unconverted items remain intact in localStorage.
 */
export async function migrateLocalStorageToIndexedDb(): Promise<{
  migratedCount: number;
  skippedCount: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let migratedCount = 0;
  let skippedCount = 0;

  if (typeof window === 'undefined' || !window.localStorage) {
    return { migratedCount: 0, skippedCount: 0, errors: [] };
  }

  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return { migratedCount: 0, skippedCount: 0, errors: [] };
    }

    const legacyList = JSON.parse(raw);
    if (!Array.isArray(legacyList)) {
      return { migratedCount: 0, skippedCount: 0, errors: ['Invalid legacy storage format'] };
    }

    const remainingLegacy: any[] = [];

    for (const legacy of legacyList) {
      try {
        if (!legacy || !legacy.id) continue;

        const compositeKey = legacy.id.includes(':')
          ? legacy.id
          : buildOutboxKey(legacy.userId, legacy.taskId, legacy.sessionId);

        // Check if already in IndexedDB
        const existing = await getOutboxItem(compositeKey);
        if (existing) {
          skippedCount++;
          continue;
        }

        const outboxIntent: DurableDeletionIntent = {
          id: compositeKey,
          userId: legacy.userId && legacy.userId.trim() ? legacy.userId : 'user-default',
          taskId: legacy.taskId,
          sessionId: legacy.sessionId || 'all',
          entityType: legacy.sessionId && legacy.sessionId !== 'all' ? 'session' : 'task',
          googleCalendarEventId: legacy.googleCalendarEventId,
          deletedAt: legacy.deletedAt || new Date().toISOString(),
          status: legacy.status || 'cleaned',
          syncStatus: 'pending_sync', // Queue for Firestore authoritative synchronization
          syncAttempts: 0,
          retryCount: legacy.retryCount || 0,
          lastError: legacy.lastError,
          lastAttemptAt: legacy.lastAttemptAt,
          updatedAt: new Date().toISOString(),
        };

        await saveToOutbox(outboxIntent);
        migratedCount++;
      } catch (err: any) {
        errors.push(`Failed to migrate tombstone ${legacy?.id}: ${err.message || String(err)}`);
        remainingLegacy.push(legacy);
      }
    }

    // Only update localStorage if some items failed; otherwise keep as migration backup or clean up safely
    if (remainingLegacy.length === 0 && errors.length === 0) {
      // Keep legacy key with migrated flag to prevent repeated work
      localStorage.setItem(`${LEGACY_STORAGE_KEY}_migrated_at`, new Date().toISOString());
    } else {
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(remainingLegacy));
    }
  } catch (err: any) {
    errors.push(`Migration exception: ${err.message || String(err)}`);
  }

  return { migratedCount, skippedCount, errors };
}

/**
 * Clears all outbox records (used for test suites and hard factory reset)
 */
export async function clearIndexedDbOutbox(): Promise<void> {
  inMemoryStore.clear();
  try {
    const db = await openOutboxDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      const store = tx.objectStore(OUTBOX_STORE);
      const req = store.clear();

      tx.oncomplete = () => {
        db.close();
        resolve();
      };

      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('Failed to clear outbox store'));
      };
    });
  } catch {
    // Memory store cleared above
  }
}
