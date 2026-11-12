/**
 * Durable IndexedDB Deletion Outbox
 *
 * Implements offline-first durable local storage for deletion intents.
 * Acts as an outbox until deletion tombstones are authoritatively acknowledged by Firestore.
 * Conforms to Phase 2A.3.4.4 architectural requirements and review hardening.
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
  cleanupClaimToken?: string;
  updatedAt: string; // ISO 8601 string
}

export const DB_NAME = 'even_planner_db';
export const DB_VERSION = 1;
export const OUTBOX_STORE = 'deletion_outbox';
export const LEGACY_STORAGE_KEY = 'even_deletion_tombstones_v1';

// In-memory fallback store ONLY when explicitly allowed for SSR/testing
const inMemoryStore = new Map<string, DurableDeletionIntent>();
let memoryFallbackExplicitlyAllowed = typeof window === 'undefined';
let customIdbFactory: IDBFactory | null = null;

export function setAllowMemoryFallback(allowed: boolean): void {
  memoryFallbackExplicitlyAllowed = allowed;
}

export function isMemoryFallbackAllowed(): boolean {
  return memoryFallbackExplicitlyAllowed;
}

export function setCustomIdbFactory(factory: IDBFactory | null): void {
  customIdbFactory = factory;
}

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
 * Detects if native or custom IndexedDB is available
 */
export function getIndexedDbInstance(): IDBFactory | null {
  if (customIdbFactory) {
    return customIdbFactory;
  }
  if (typeof globalThis !== 'undefined' && globalThis.indexedDB) {
    return globalThis.indexedDB;
  }
  if (typeof window !== 'undefined' && window.indexedDB) {
    return window.indexedDB;
  }
  return null;
}

/**
 * Opens connection to IndexedDB database with schema versioning.
 * Strictly throws if IndexedDB cannot be opened.
 */
export function openOutboxDatabase(): Promise<IDBDatabase> {
  const idb = getIndexedDbInstance();
  if (!idb) {
    if (memoryFallbackExplicitlyAllowed) {
      return Promise.reject(new Error('INDEXEDDB_UNAVAILABLE_USE_FALLBACK'));
    }
    return Promise.reject(
      new Error('IndexedDB tidak tersedia pada runtime ini dan memory fallback dinonaktifkan')
    );
  }

  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      return reject(err);
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
        store.createIndex('by_userId', 'userId', { unique: false });
        store.createIndex('by_syncStatus', 'syncStatus', { unique: false });
        store.createIndex('by_deletedAt', 'deletedAt', { unique: false });
        store.createIndex('by_user_syncStatus', ['userId', 'syncStatus'], { unique: false });
      }
    };

    req.onsuccess = () => {
      resolve(req.result);
    };

    req.onerror = () => {
      reject(req.error || new Error('Gagal membuka database IndexedDB'));
    };

    req.onblocked = () => {
      console.warn('IndexedDB database upgrade diblokir oleh koneksi aktif');
    };
  });
}

/**
 * Persists a deletion intent durably into IndexedDB Outbox.
 * Guarantees transaction completion (tx.oncomplete) before resolving.
 * If IndexedDB fails or transaction fails, it MUST REJECT so caller knows durable storage failed.
 */
export async function saveToOutbox(intent: DurableDeletionIntent): Promise<void> {
  const idb = getIndexedDbInstance();

  if (!idb) {
    if (memoryFallbackExplicitlyAllowed) {
      inMemoryStore.set(intent.id, intent);
      return;
    }
    throw new Error('IndexedDB tidak tersedia di environment ini dan memory fallback tidak diizinkan');
  }

  let db: IDBDatabase;
  try {
    db = await openOutboxDatabase();
  } catch (err: any) {
    // Retain in memory cache to avoid losing intent in current process, but throw error!
    inMemoryStore.set(intent.id, intent);
    throw new Error(`Gagal membuka IndexedDB untuk penyimpanan outbox: ${err?.message || String(err)}`);
  }

  return new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(OUTBOX_STORE, 'readwrite');
    } catch (err: any) {
      db.close();
      inMemoryStore.set(intent.id, intent);
      return reject(new Error(`Gagal memulai transaksi IndexedDB: ${err?.message || String(err)}`));
    }

    const store = tx.objectStore(OUTBOX_STORE);
    try {
      store.put(intent);
    } catch (err: any) {
      db.close();
      inMemoryStore.set(intent.id, intent);
      return reject(err);
    }

    tx.oncomplete = () => {
      // Keep memory cache aligned
      inMemoryStore.set(intent.id, intent);
      db.close();
      resolve();
    };

    tx.onerror = () => {
      const err = tx.error || new Error('Transaksi IndexedDB gagal disimpan');
      db.close();
      inMemoryStore.set(intent.id, intent);
      reject(err);
    };

    tx.onabort = () => {
      db.close();
      inMemoryStore.set(intent.id, intent);
      reject(new Error('Transaksi IndexedDB dibatalkan (aborted)'));
    };
  });
}

/**
 * Retrieves a single outbox item by its composite key.
 */
export async function getOutboxItem(id: string): Promise<DurableDeletionIntent | undefined> {
  const idb = getIndexedDbInstance();
  if (!idb) {
    if (memoryFallbackExplicitlyAllowed) {
      return inMemoryStore.get(id);
    }
    throw new Error('IndexedDB tidak tersedia di environment ini');
  }

  const db = await openOutboxDatabase();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(OUTBOX_STORE, 'readonly');
    } catch (err) {
      db.close();
      return reject(err);
    }

    const store = tx.objectStore(OUTBOX_STORE);
    const req = store.get(id);

    req.onsuccess = () => {
      db.close();
      resolve(req.result || undefined);
    };

    req.onerror = () => {
      db.close();
      reject(req.error || new Error('Gagal membaca item outbox'));
    };
  });
}

/**
 * Retrieves all deletion intents from the outbox, optionally filtered by user ID.
 */
export async function getAllOutboxItems(userId?: string): Promise<DurableDeletionIntent[]> {
  const idb = getIndexedDbInstance();
  if (!idb) {
    if (memoryFallbackExplicitlyAllowed) {
      const all = Array.from(inMemoryStore.values());
      return userId ? all.filter((item) => item.userId === userId) : all;
    }
    throw new Error('IndexedDB tidak tersedia di environment ini');
  }

  const db = await openOutboxDatabase();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(OUTBOX_STORE, 'readonly');
    } catch (err) {
      db.close();
      return reject(err);
    }

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
      reject(req.error || new Error('Gagal membaca seluruh item outbox'));
    };
  });
}

/**
 * Retrieves all outbox items that require synchronization or retry.
 */
export async function getPendingSyncOutboxItems(userId?: string): Promise<DurableDeletionIntent[]> {
  const idb = getIndexedDbInstance();
  if (!idb) {
    if (memoryFallbackExplicitlyAllowed) {
      return Array.from(inMemoryStore.values()).filter(
        (item) => (item.syncStatus === 'pending_sync' || item.syncStatus === 'sync_failed') && (!userId || item.userId === userId)
      );
    }
    throw new Error('IndexedDB tidak tersedia di environment ini');
  }

  const db = await openOutboxDatabase();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(OUTBOX_STORE, 'readonly');
    } catch (err) {
      db.close();
      return reject(err);
    }

    const store = tx.objectStore(OUTBOX_STORE);
    let req: IDBRequest<any>;
    if (userId) {
      req = store.index('by_userId').getAll(userId);
    } else {
      req = store.getAll();
    }

    req.onsuccess = () => {
      db.close();
      const list: DurableDeletionIntent[] = req.result || [];
      resolve(list.filter((i) =>
        (i.syncStatus === 'pending_sync' || i.syncStatus === 'sync_failed') &&
        (!userId || i.userId === userId)
      ));
    };

    req.onerror = () => {
      db.close();
      reject(req.error || new Error('Gagal membaca pending sync outbox items'));
    };
  });
}

/**
 * Marks an outbox item as synchronized after Firestore confirmation.
 */
export async function markOutboxItemSynced(id: string, authoritativePatch: Partial<DurableDeletionIntent> = {}): Promise<void> {
  const existing = await getOutboxItem(id);
  if (!existing) return;

  const updated: DurableDeletionIntent = {
    ...existing,
    ...authoritativePatch,
    syncStatus: 'synced',
    syncError: undefined,
    updatedAt: new Date().toISOString(),
  };

  await saveToOutbox(updated);
}

/**
 * Records synchronization failure for an outbox item.
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
  const idb = getIndexedDbInstance();
  if (!idb) {
    if (memoryFallbackExplicitlyAllowed) {
      inMemoryStore.delete(id);
      return;
    }
    throw new Error('IndexedDB tidak tersedia di environment ini');
  }

  const db = await openOutboxDatabase();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(OUTBOX_STORE, 'readwrite');
    } catch (err) {
      db.close();
      return reject(err);
    }

    const store = tx.objectStore(OUTBOX_STORE);
    store.delete(id);

    tx.oncomplete = () => {
      inMemoryStore.delete(id);
      db.close();
      resolve();
    };

    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Gagal menghapus item outbox'));
    };

    tx.onabort = () => {
      db.close();
      reject(new Error('Transaksi penghapusan outbox dibatalkan'));
    };
  });
}

/**
 * Migrates legacy localStorage tombstones to IndexedDB outbox.
 * Idempotent: Does not remove localStorage item until IndexedDB write is confirmed.
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
      return { migratedCount: 0, skippedCount: 0, errors: ['Format legacy storage tidak valid'] };
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
          syncStatus: 'pending_sync',
          syncAttempts: 0,
          retryCount: legacy.retryCount || 0,
          lastError: legacy.lastError,
          lastAttemptAt: legacy.lastAttemptAt,
          updatedAt: new Date().toISOString(),
        };

        await saveToOutbox(outboxIntent);
        migratedCount++;
      } catch (err: any) {
        errors.push(`Gagal memigrasikan tombstone ${legacy?.id}: ${err.message || String(err)}`);
        remainingLegacy.push(legacy);
      }
    }

    if (remainingLegacy.length === 0 && errors.length === 0) {
      localStorage.setItem(`${LEGACY_STORAGE_KEY}_migrated_at`, new Date().toISOString());
    } else {
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(remainingLegacy));
    }
  } catch (err: any) {
    errors.push(`Eksepsi migrasi: ${err.message || String(err)}`);
  }

  return { migratedCount, skippedCount, errors };
}

/**
 * Clears all outbox records (used for test suites and hard reset).
 */
export async function clearIndexedDbOutbox(): Promise<void> {
  inMemoryStore.clear();
  const idb = getIndexedDbInstance();
  if (!idb) {
    return;
  }

  try {
    const db = await openOutboxDatabase();
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(OUTBOX_STORE, 'readwrite');
      } catch (err) {
        db.close();
        return resolve();
      }

      const store = tx.objectStore(OUTBOX_STORE);
      store.clear();

      tx.oncomplete = () => {
        db.close();
        resolve();
      };

      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('Gagal membersihkan store outbox'));
      };
    });
  } catch {
    // If database cannot be opened, memory was already cleared
  }
}
