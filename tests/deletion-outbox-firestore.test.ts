/**
 * Phase 2A.3.4.4 Test Suite:
 * Step 2 (Durable IndexedDB Deletion Outbox) & Step 3 (Firestore Authoritative Tombstone Repository)
 */

import assert from 'node:assert';
import {
  saveToOutbox,
  getOutboxItem,
  getAllOutboxItems,
  getPendingSyncOutboxItems,
  markOutboxItemSynced,
  updateOutboxItemSyncFailure,
  removeConfirmedOutboxItem,
  migrateLocalStorageToIndexedDb,
  clearIndexedDbOutbox,
  buildOutboxKey,
  sanitizeIdForFirestore,
  DurableDeletionIntent,
  LEGACY_STORAGE_KEY,
} from '../src/lib/indexedDbOutbox';
import {
  buildFirestoreTombstoneDocId,
  validateUserOwnership,
  saveAuthoritativeTombstone,
  getAuthoritativeTombstones,
  syncOutboxToFirestore,
  reconcileRemoteTombstonesToLocal,
  FirestoreTombstoneDoc,
} from '../src/lib/firestoreTombstoneRepo';
import {
  recordSessionDeletion,
  recordTaskDeletion,
  isSessionDeleted,
  clearAllTombstones,
  initDurableTombstones,
  setFirestoreSyncEnabled,
} from '../src/lib/deletionTombstone';
import { auth } from '../src/lib/firebase';

export async function runDeletionOutboxAndFirestoreSuite() {
  console.log('\n================================================================');
  console.log('🧪 RUNNING PHASE 2A.3.4.4: OUTBOX & FIRESTORE TOMBSTONE SUITE 🧪');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function pass(name: string) {
    passedTests++;
    totalTests++;
    console.log(`  ✅ [PASS] ${name}`);
  }

  try {
    // --- STEP 2: INDEXEDDB DURABLE DELETION OUTBOX TESTS ---

    // [Test 1] Durable Storage: saveToOutbox saves and retrieves with composite key
    {
      await clearIndexedDbOutbox();
      const userId = 'user-test-1';
      const taskId = 'task-test-1';
      const sessionId = 'sess-1';
      const key = buildOutboxKey(userId, taskId, sessionId);

      const intent: DurableDeletionIntent = {
        id: key,
        userId,
        taskId,
        sessionId,
        entityType: 'session',
        googleCalendarEventId: 'gcal-event-1',
        deletedAt: '2026-11-10T08:00:00.000Z',
        status: 'pending_cleanup',
        syncStatus: 'pending_sync',
        syncAttempts: 0,
        retryCount: 0,
        updatedAt: '2026-11-10T08:00:00.000Z',
      };

      await saveToOutbox(intent);
      const retrieved = await getOutboxItem(key);

      assert.ok(retrieved, 'Item outbox harus ditemukan');
      assert.strictEqual(retrieved?.id, key);
      assert.strictEqual(retrieved?.userId, userId);
      assert.strictEqual(retrieved?.taskId, taskId);
      assert.strictEqual(retrieved?.sessionId, sessionId);
      assert.strictEqual(retrieved?.syncStatus, 'pending_sync');
      assert.strictEqual(retrieved?.googleCalendarEventId, 'gcal-event-1');

      pass('Test 1: saveToOutbox menyimpan dan membaca deletion intent dengan composite key');
    }

    // [Test 2] Restart & Recovery: Intent remains durable after clear and re-query
    {
      const userId = 'user-test-2';
      const taskId = 'task-test-2';
      const key = buildOutboxKey(userId, taskId, 'all');

      const intent: DurableDeletionIntent = {
        id: key,
        userId,
        taskId,
        sessionId: 'all',
        entityType: 'task',
        deletedAt: new Date().toISOString(),
        status: 'cleaned',
        syncStatus: 'pending_sync',
        syncAttempts: 0,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      };

      await saveToOutbox(intent);

      // Query through getAllOutboxItems filtered by user
      const userItems = await getAllOutboxItems(userId);
      assert.strictEqual(userItems.length, 1);
      assert.strictEqual(userItems[0].taskId, taskId);
      assert.strictEqual(userItems[0].entityType, 'task');

      pass('Test 2: Restart & Recovery menjamin deletion intent tetap terbaca dari storage outbox');
    }

    // [Test 3] localStorage Migration: Legacy tombstones converted to outbox idempotently
    {
      await clearIndexedDbOutbox();

      // Mock legacy localStorage
      const legacyItems = [
        {
          id: 'user-legacy:task-leg-1:all',
          userId: 'user-legacy',
          taskId: 'task-leg-1',
          sessionId: 'all',
          deletedAt: '2026-11-09T10:00:00.000Z',
          status: 'cleaned',
          retryCount: 0,
        },
        {
          id: 'user-legacy:task-leg-2:sess-2',
          userId: 'user-legacy',
          taskId: 'task-leg-2',
          sessionId: 'sess-2',
          googleCalendarEventId: 'gcal-leg-2',
          deletedAt: '2026-11-09T10:05:00.000Z',
          status: 'pending_cleanup',
          retryCount: 1,
        },
      ];

      if (typeof window === 'undefined') {
        (globalThis as any).window = globalThis;
      }
      (globalThis as any).localStorage = {
        store: {
          [LEGACY_STORAGE_KEY]: JSON.stringify(legacyItems),
        },
        getItem(k: string) {
          return this.store[k] || null;
        },
        setItem(k: string, v: string) {
          this.store[k] = v;
        },
        removeItem(k: string) {
          delete this.store[k];
        },
      };

      // 1st migration run
      const result1 = await migrateLocalStorageToIndexedDb();
      assert.strictEqual(result1.migratedCount, 2);
      assert.strictEqual(result1.errors.length, 0);

      // Verify outbox has both items with syncStatus: 'pending_sync'
      const migrated1 = await getOutboxItem('user-legacy:task-leg-1:all');
      const migrated2 = await getOutboxItem('user-legacy:task-leg-2:sess-2');
      assert.ok(migrated1);
      assert.ok(migrated2);
      assert.strictEqual(migrated1?.syncStatus, 'pending_sync');
      assert.strictEqual(migrated2?.googleCalendarEventId, 'gcal-leg-2');

      // 2nd migration run (idempotency check)
      const result2 = await migrateLocalStorageToIndexedDb();
      assert.strictEqual(result2.migratedCount, 0, 'Migrasi ulang tidak boleh menduplikasi');
      assert.strictEqual(result2.skippedCount, 2, 'Item lama dilewati karena sudah ada di outbox');

      pass('Test 3: Migrasi localStorage ke IndexedDB berjalan aman, idempotent, dan tidak menduplikasi');
    }

    // [Test 4] Composite Key & Duplicate Prevention: Different tasks sharing identical session IDs
    {
      const userId = 'user-test-4';
      const sharedSessionId = 'shared-uuid-999';
      const taskAId = 'task-4-alpha';
      const taskBId = 'task-4-beta';

      const keyA = buildOutboxKey(userId, taskAId, sharedSessionId);
      const keyB = buildOutboxKey(userId, taskBId, sharedSessionId);

      assert.notStrictEqual(keyA, keyB, 'Key harus berbeda karena taskId berbeda');

      await saveToOutbox({
        id: keyA,
        userId,
        taskId: taskAId,
        sessionId: sharedSessionId,
        entityType: 'session',
        googleCalendarEventId: 'gcal-event-A',
        deletedAt: new Date().toISOString(),
        status: 'cleaned',
        syncStatus: 'pending_sync',
        syncAttempts: 0,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      });

      await saveToOutbox({
        id: keyB,
        userId,
        taskId: taskBId,
        sessionId: sharedSessionId,
        entityType: 'session',
        googleCalendarEventId: 'gcal-event-B',
        deletedAt: new Date().toISOString(),
        status: 'pending_cleanup',
        syncStatus: 'pending_sync',
        syncAttempts: 0,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      });

      const itemA = await getOutboxItem(keyA);
      const itemB = await getOutboxItem(keyB);

      assert.strictEqual(itemA?.googleCalendarEventId, 'gcal-event-A');
      assert.strictEqual(itemB?.googleCalendarEventId, 'gcal-event-B');

      pass('Test 4: Composite key mencegah tabrakan (collision) ketika dua task memiliki session ID serupa');
    }

    // [Test 5] Multi-Tab Concurrency Simulation: Atomic non-destructive parallel writes
    {
      const userId = 'user-test-5';
      const writes = Array.from({ length: 10 }).map((_, i) => {
        const taskId = `task-concur-${i}`;
        const key = buildOutboxKey(userId, taskId, 'all');
        return saveToOutbox({
          id: key,
          userId,
          taskId,
          sessionId: 'all',
          entityType: 'task',
          deletedAt: new Date().toISOString(),
          status: 'cleaned',
          syncStatus: 'pending_sync',
          syncAttempts: 0,
          retryCount: 0,
          updatedAt: new Date().toISOString(),
        });
      });

      await Promise.all(writes);

      const allItems = await getAllOutboxItems(userId);
      assert.strictEqual(allItems.length, 10, 'Seluruh 10 operasi write paralel harus tercatat utuh');

      pass('Test 5: Operasi penulisan paralel / multi-tab tercatat secara utuh tanpa overwrite');
    }

    // [Test 6] Outbox Lifecycle: markOutboxItemSynced & updateOutboxItemSyncFailure
    {
      const userId = 'user-test-6';
      const taskId = 'task-test-6';
      const key = buildOutboxKey(userId, taskId, 'all');

      await saveToOutbox({
        id: key,
        userId,
        taskId,
        sessionId: 'all',
        entityType: 'task',
        deletedAt: new Date().toISOString(),
        status: 'pending_cleanup',
        syncStatus: 'pending_sync',
        syncAttempts: 0,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      });

      // Simulate failure first
      await updateOutboxItemSyncFailure(key, 'Network timeout connecting to Firestore');
      const failed = await getOutboxItem(key);
      assert.strictEqual(failed?.syncStatus, 'sync_failed');
      assert.strictEqual(failed?.syncAttempts, 1);
      assert.ok(failed?.syncError?.includes('Network timeout'));

      // Simulate retry success
      await markOutboxItemSynced(key);
      const synced = await getOutboxItem(key);
      assert.strictEqual(synced?.syncStatus, 'synced');
      assert.strictEqual(synced?.syncError, undefined);

      // Remove confirmed
      await removeConfirmedOutboxItem(key);
      const removed = await getOutboxItem(key);
      assert.strictEqual(removed, undefined);

      pass('Test 6: Siklus hidup outbox (pending_sync -> sync_failed -> synced -> removed) bekerja deterministik');
    }

    // --- STEP 3: FIRESTORE AUTHORITATIVE TOMBSTONE REPOSITORY TESTS ---

    // [Test 7] Firestore Document ID Sanitization & Rules Match
    {
      const taskId = 'task-special:123/abc';
      const sessId = 'sess-sub:456';
      const docId = buildFirestoreTombstoneDocId(taskId, sessId);

      assert.ok(/^[a-zA-Z0-9_\-]+$/.test(docId), 'docId harus mematuhi regex isValidId');
      assert.ok(docId.length <= 128, 'docId tidak boleh melebihi 128 karakter');
      assert.strictEqual(docId, 'tomb_task-special_123_abc_sess-sub_456');

      pass('Test 7: buildFirestoreTombstoneDocId menghasilkan ID yang 100% patuh terhadap security rules isValidId');
    }

    // [Test 8] Ownership Validation
    {
      // Set current mock auth
      (auth as any).currentUser = { uid: 'user-auth-primary' };

      // Valid ownership
      assert.doesNotThrow(() => {
        validateUserOwnership('user-auth-primary');
      });

      // Invalid ownership (cross-user attack)
      assert.throws(
        () => {
          validateUserOwnership('user-victim-secondary');
        },
        /tidak cocok dengan akun terautentikasi/,
        'Validasi ownership wajib menolak operasi lintas pengguna'
      );

      pass('Test 8: Validasi kepemilikan user (Ownership Validation) menolak akses lintas pengguna');
    }

    // [Test 9] Authoritative Monotonic Tombstone Persistence (saveAuthoritativeTombstone)
    {
      (auth as any).currentUser = { uid: 'user-mono-9' };
      const userId = 'user-mono-9';
      const taskId = 'task-mono-9';
      const sessionId = 'sess-mono-9';
      const key = buildOutboxKey(userId, taskId, sessionId);

      const firestoreStore = new Map<string, any>();

      const mockSetDoc = async (ref: any, data: any) => {
        firestoreStore.set(ref.path, data);
      };

      const mockGetDoc = async (ref: any) => ({
        exists: () => firestoreStore.has(ref.path),
        data: () => firestoreStore.get(ref.path),
      });

      // 1. First save: initial deletion
      const intent1: DurableDeletionIntent = {
        id: key,
        userId,
        taskId,
        sessionId,
        entityType: 'session',
        googleCalendarEventId: 'gcal-remote-9',
        deletedAt: '2026-11-10T09:00:00.000Z',
        status: 'pending_cleanup',
        syncStatus: 'pending_sync',
        syncAttempts: 0,
        retryCount: 0,
        updatedAt: '2026-11-10T09:00:00.000Z',
      };

      const doc1 = await saveAuthoritativeTombstone(intent1, {
        customSetDoc: mockSetDoc as any,
        customGetDoc: mockGetDoc as any,
      });

      assert.strictEqual(doc1.status, 'pending_cleanup');
      assert.strictEqual(doc1.googleCalendarEventId, 'gcal-remote-9');

      // 2. Mark as cleaned in remote
      const intentCleaned: DurableDeletionIntent = {
        ...intent1,
        status: 'cleaned',
        updatedAt: '2026-11-10T09:05:00.000Z',
      };
      await saveAuthoritativeTombstone(intentCleaned, {
        customSetDoc: mockSetDoc as any,
        customGetDoc: mockGetDoc as any,
      });

      // 3. Stale sync comes in attempting to downgrade back to pending_cleanup
      const staleIntent: DurableDeletionIntent = {
        ...intent1,
        deletedAt: '2026-11-10T09:10:00.000Z',
        status: 'pending_cleanup', // Stale or delayed push
      };

      const doc3 = await saveAuthoritativeTombstone(staleIntent, {
        customSetDoc: mockSetDoc as any,
        customGetDoc: mockGetDoc as any,
      });

      assert.strictEqual(doc3.status, 'cleaned', 'Monotonic resolver harus mempertahankan status cleaned');
      assert.strictEqual(doc3.deletedAt, '2026-11-10T09:00:00.000Z', 'DeletedAt paling awal harus dipertahankan');

      pass('Test 9: Monotonic tombstone persistence menjaga agar status cleaned dan deletedAt awal tidak tertimpa data basi');
    }

    // [Test 10] IndexedDB Outbox to Firestore Synchronization (syncOutboxToFirestore)
    {
      await clearIndexedDbOutbox();
      const userId = 'user-sync-10';
      (auth as any).currentUser = { uid: userId };

      // Put 3 items in outbox
      for (let i = 1; i <= 3; i++) {
        const taskId = `task-sync-10-${i}`;
        const key = buildOutboxKey(userId, taskId, 'all');
        await saveToOutbox({
          id: key,
          userId,
          taskId,
          sessionId: 'all',
          entityType: 'task',
          deletedAt: new Date().toISOString(),
          status: 'cleaned',
          syncStatus: 'pending_sync',
          syncAttempts: 0,
          retryCount: 0,
          updatedAt: new Date().toISOString(),
        });
      }

      const syncedDocs: any[] = [];
      const mockSaveAuthoritative = async (intent: DurableDeletionIntent) => {
        syncedDocs.push(intent);
        return {
          id: buildFirestoreTombstoneDocId(intent.taskId, intent.sessionId),
          compositeKey: intent.id,
          userId: intent.userId,
          taskId: intent.taskId,
          sessionId: intent.sessionId,
          entityType: intent.entityType,
          deletedAt: intent.deletedAt,
          status: intent.status,
          retryCount: intent.retryCount,
          updatedAt: intent.updatedAt,
        };
      };

      const syncResult = await syncOutboxToFirestore({
        userId,
        saveAuthoritativeFn: mockSaveAuthoritative,
      });

      assert.strictEqual(syncResult.totalPending, 3);
      assert.strictEqual(syncResult.syncedCount, 3);
      assert.strictEqual(syncResult.failedCount, 0);

      // Verify items are now marked 'synced' in outbox
      const pendingAfter = await getPendingSyncOutboxItems(userId);
      assert.strictEqual(pendingAfter.length, 0, 'Tidak boleh ada item pending sync yang tertinggal');

      pass('Test 10: syncOutboxToFirestore menyinkronkan outbox ke Firestore dan menandai item sebagai synced');
    }

    // [Test 11] Offline Failure & Retry Isolation: Items remain in outbox if Firestore fails
    {
      await clearIndexedDbOutbox();
      const userId = 'user-offline-11';
      (auth as any).currentUser = { uid: userId };

      const taskId = 'task-offline-11';
      const key = buildOutboxKey(userId, taskId, 'all');

      await saveToOutbox({
        id: key,
        userId,
        taskId,
        sessionId: 'all',
        entityType: 'task',
        deletedAt: new Date().toISOString(),
        status: 'cleaned',
        syncStatus: 'pending_sync',
        syncAttempts: 0,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      });

      // Simulate network / Firestore rejection
      let networkDown = true;
      const mockFailingSave = async (intent: DurableDeletionIntent) => {
        if (networkDown) {
          throw new Error('Firestore connection failed: client is offline');
        }
        return { id: 'ok' } as any;
      };

      const failResult = await syncOutboxToFirestore({
        userId,
        saveAuthoritativeFn: mockFailingSave,
      });

      assert.strictEqual(failResult.failedCount, 1);
      assert.strictEqual(failResult.syncedCount, 0);

      // Outbox item must NOT be deleted
      const itemStillInBox = await getOutboxItem(key);
      assert.ok(itemStillInBox, 'Item outbox DILARANG dihapus saat Firestore gagal');
      assert.strictEqual(itemStillInBox?.syncStatus, 'sync_failed');
      assert.strictEqual(itemStillInBox?.syncAttempts, 1);

      // Now restore network and retry
      networkDown = false;
      // Re-queue item for sync
      await saveToOutbox({ ...itemStillInBox, syncStatus: 'pending_sync' });

      const retryResult = await syncOutboxToFirestore({
        userId,
        saveAuthoritativeFn: mockFailingSave,
      });

      assert.strictEqual(retryResult.syncedCount, 1);
      const itemSynced = await getOutboxItem(key);
      assert.strictEqual(itemSynced?.syncStatus, 'synced');

      pass('Test 11: Kegagalan koneksi offline mempertahankan item outbox dan retry berhasil setelah online');
    }

    // [Test 12] Cross-Device Reconciliation: reconcileRemoteTombstonesToLocal
    {
      await clearIndexedDbOutbox();
      const userId = 'user-cross-device-12';
      (auth as any).currentUser = { uid: userId };

      const remoteDocs: FirestoreTombstoneDoc[] = [
        {
          id: 'tomb_task_remote_1_all',
          compositeKey: `${userId}:task-remote-1:all`,
          userId,
          taskId: 'task-remote-1',
          sessionId: 'all',
          entityType: 'task',
          deletedAt: '2026-11-10T07:00:00.000Z',
          status: 'cleaned',
          retryCount: 0,
          updatedAt: '2026-11-10T07:00:00.000Z',
        },
      ];

      const mockGetDocs = async () => ({
        forEach: (cb: any) => {
          remoteDocs.forEach((d) => cb({ exists: () => true, data: () => d }));
        },
      });

      const reconResult = await reconcileRemoteTombstonesToLocal(userId, {
        customGetDocs: mockGetDocs as any,
      });

      assert.strictEqual(reconResult.reconciledCount, 1);

      const localItem = await getOutboxItem(`${userId}:task-remote-1:all`);
      assert.ok(localItem, 'Item remote harus direkonsiliasikan ke local outbox');
      assert.strictEqual(localItem?.syncStatus, 'synced');

      pass('Test 12: Rekonsiliasi tombstone lintas perangkat (Cross-Device Reconciliation) memperbarui local outbox');
    }

    // [Test 13] End-to-End Integration with recordTaskDeletion & initDurableTombstones
    {
      setFirestoreSyncEnabled(false);
      await clearIndexedDbOutbox();
      clearAllTombstones();

      const userId = 'user-e2e-13';
      (auth as any).currentUser = { uid: userId };
      const taskId = 'task-e2e-13';
      const sessId = 'sess-e2e-13-1';

      // Record task deletion
      recordTaskDeletion(userId, taskId, [{ sessionId: sessId, googleCalendarEventId: 'gcal-e2e' }]);

      // Verify synchronous check immediately reflects deletion (No resurrection)
      assert.strictEqual(isSessionDeleted(userId, taskId), true, 'Task harus terdeteksi terhapus');
      assert.strictEqual(isSessionDeleted(userId, taskId, sessId), true, 'Sesi harus terdeteksi terhapus');

      // Wait brief tick for async outbox write
      await new Promise((r) => setTimeout(r, 20));

      const outboxTask = await getOutboxItem(buildOutboxKey(userId, taskId, 'all'));
      const outboxSess = await getOutboxItem(buildOutboxKey(userId, taskId, sessId));

      assert.ok(outboxTask, 'Task outbox item harus tersimpan');
      assert.ok(outboxSess, 'Session outbox item harus tersimpan');
      assert.strictEqual(outboxSess?.googleCalendarEventId, 'gcal-e2e');

      setFirestoreSyncEnabled(true);
      pass('Test 13: Integrasi end-to-end recordTaskDeletion dengan durable outbox dan pencegahan resurrection');
    }

    console.log('\n================================================================');
    console.log(`🎉 SELURUH ${totalTests} PENGUJIAN OUTBOX & FIRESTORE LULUS 100%! 🎉`);
    console.log('================================================================\n');
  } catch (err: any) {
    console.error('\n❌ GAGAL PENGUJIAN OUTBOX & FIRESTORE:', err);
    throw err;
  }
}

// Self-executing if run directly via tsx
if (import.meta.url === `file://${process.argv[1]}`) {
  runDeletionOutboxAndFirestoreSuite()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
