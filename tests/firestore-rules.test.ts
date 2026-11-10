/**
 * Firebase Firestore Security Rules Test Suite
 *
 * Uses @firebase/rules-unit-testing against firestore.rules to verify:
 * 1. Valid tombstone creation
 * 2. Valid status update (e.g. pending_cleanup -> cleaning -> cleaned)
 * 3. Invalid status transitions (e.g. cleaning -> pending_cleanup)
 * 4. Remote ID changes violating state machine (cleaned -> cleaned with new remote ID rejected)
 * 5. Monotonic retryCount enforcement (decreasing retryCount rejected)
 * 6. Identity field immutability (changing taskId/userId/sessionId/compositeKey rejected)
 * 7. deletedAt immutability (modifying deletion timestamp rejected)
 * 8. Deletion prohibition (deleting tombstone document rejected)
 * 9. Ownership isolation (unauthenticated or other user access rejected)
 * 10. Valid reactivation on new remote ID (cleaned -> pending_cleanup when new remote ID arrives)
 *
 * NOTE: If Firebase Emulator is not running (e.g. in environments without Java JRE),
 * runtime emulator tests report status as NOT VERIFIED and instruct on how to run locally.
 */

import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

export async function runFirestoreRulesSuite() {
  console.log('\n================================================================');
  console.log('🛡️  RUNNING FIRESTORE SECURITY RULES VERIFICATION SUITE 🛡️');
  console.log('================================================================\n');

  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  if (!fs.existsSync(rulesPath)) {
    throw new Error(`File firestore.rules tidak ditemukan di ${rulesPath}`);
  }
  const rulesContent = fs.readFileSync(rulesPath, 'utf8');

  // Verify static syntax and presence of key security constructs
  console.log('  🔍 [STATIC AUDIT] Memeriksa konstruksi keamanan firestore.rules...');
  assert.ok(
    rulesContent.includes('function isValidRemoteIdTransition'),
    'firestore.rules wajib memiliki isValidRemoteIdTransition'
  );
  assert.ok(
    rulesContent.includes('function isValidTombstoneTransition'),
    'firestore.rules wajib memiliki isValidTombstoneTransition'
  );
  assert.ok(
    rulesContent.includes("prevStatus == 'cleaned' && nextStatus == 'cleaned' && !hasNewRemoteId"),
    'firestore.rules wajib mencegah cleaned -> cleaned jika hasNewRemoteId bernilai true'
  );
  assert.ok(
    rulesContent.includes("prevStatus == 'cleaned' && nextStatus == 'pending_cleanup' && hasNewRemoteId"),
    'firestore.rules wajib mensyaratkan hasNewRemoteId saat transisi cleaned -> pending_cleanup'
  );
  assert.ok(
    rulesContent.includes('incoming().retryCount >= existing().retryCount'),
    'firestore.rules wajib menegakkan monotonic retryCount'
  );
  assert.ok(
    rulesContent.includes('incoming().deletedAt == existing().deletedAt'),
    'firestore.rules wajib menegakkan imutabilitas deletedAt'
  );
  assert.ok(
    rulesContent.includes('allow delete: if false'),
    'firestore.rules wajib melarang penghapusan dokumen tombstone'
  );
  console.log('  ✅ [PASS] Static Audit: Seluruh konstruksi aturan keamanan deletion_tombstones terverifikasi di firestore.rules');

  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (!emulatorHost) {
    console.log('\n  ⚠️  [STATUS: NOT VERIFIED] Firebase Emulator Suite tidak aktif di container ini.');
    console.log('  ⚠️  Penyebab: Lingkungan sandbox ini tidak memiliki Java Runtime Environment (JRE).');
    console.log('  ℹ️  Untuk menjalankan runtime test di lingkungan lokal pengguna yang memiliki JRE:');
    console.log('      1. Pastikan Java JRE terpasang (java -version).');
    console.log('      2. Jalankan: npx firebase emulators:exec --only firestore "npx tsx tests/firestore-rules.test.ts"');
    console.log('      3. Seluruh 10 kasus pengujian di bawah ini akan dieksekusi terhadap emulator live.\n');
    return {
      status: 'NOT VERIFIED',
      reason: 'Java JRE / FIRESTORE_EMULATOR_HOST tidak tersedia di container sandbox',
    };
  }

  console.log(`  🌐 Terhubung ke Firestore Emulator di: ${emulatorHost}`);
  let testEnv: RulesTestEnvironment | null = null;

  try {
    const [host, portStr] = emulatorHost.split(':');
    testEnv = await initializeTestEnvironment({
      projectId: 'even-ai-planner-test',
      firestore: {
        rules: rulesContent,
        host: host || 'localhost',
        port: parseInt(portStr || '8080', 10),
      },
    });

    const aliceUid = 'user-alice';
    const bobUid = 'user-bob';
    const aliceDb = testEnv.authenticatedContext(aliceUid).firestore();
    const bobDb = testEnv.authenticatedContext(bobUid).firestore();
    const unauthDb = testEnv.unauthenticatedContext().firestore();

    const tombstoneDocId = 'tomb_task-rules-1_all_hash123';
    const aliceDocRef = doc(aliceDb, `users/${aliceUid}/deletion_tombstones/${tombstoneDocId}`);

    // Case 1: Valid tombstone creation
    console.log('  Running Case 1: Pembuatan tombstone yang valid');
    await assertSucceeds(
      setDoc(aliceDocRef, {
        userId: aliceUid,
        taskId: 'task-rules-1',
        sessionId: 'all',
        compositeKey: `${aliceUid}:task-rules-1:all`,
        entityType: 'task',
        deletedAt: '2026-11-10T10:00:00.000Z',
        status: 'pending_cleanup',
        retryCount: 0,
        updatedAt: '2026-11-10T10:00:00.000Z',
      })
    );

    // Case 2: Valid status update (pending_cleanup -> cleaning -> cleaned)
    console.log('  Running Case 2: Update status yang valid');
    await assertSucceeds(
      updateDoc(aliceDocRef, {
        status: 'cleaning',
        retryCount: 1,
        updatedAt: '2026-11-10T10:01:00.000Z',
      })
    );
    await assertSucceeds(
      updateDoc(aliceDocRef, {
        status: 'cleaned',
        retryCount: 1,
        updatedAt: '2026-11-10T10:02:00.000Z',
      })
    );

    // Case 3: Invalid status transition (cleaning -> pending_cleanup rejected)
    console.log('  Running Case 3: Transisi status tidak valid');
    const cleaningDocRef = doc(aliceDb, `users/${aliceUid}/deletion_tombstones/tomb_task-clean_all_hash456`);
    await assertSucceeds(
      setDoc(cleaningDocRef, {
        userId: aliceUid,
        taskId: 'task-clean',
        sessionId: 'all',
        compositeKey: `${aliceUid}:task-clean:all`,
        entityType: 'task',
        deletedAt: '2026-11-10T10:00:00.000Z',
        status: 'cleaning',
        retryCount: 1,
        updatedAt: '2026-11-10T10:00:00.000Z',
      })
    );
    await assertFails(
      updateDoc(cleaningDocRef, {
        status: 'pending_cleanup',
        retryCount: 1,
        updatedAt: '2026-11-10T10:05:00.000Z',
      })
    );

    // Case 4: Remote ID change violating state machine (cleaned -> cleaned with remote ID change rejected)
    console.log('  Running Case 4: Perubahan remote ID yang melanggar state machine');
    await assertFails(
      updateDoc(aliceDocRef, {
        status: 'cleaned',
        googleCalendarEventId: 'new-uncleaned-event-id',
        retryCount: 1,
        updatedAt: '2026-11-10T10:05:00.000Z',
      })
    );

    // Case 5: Decreasing retryCount rejected
    console.log('  Running Case 5: Penurunan retry count');
    await assertFails(
      updateDoc(aliceDocRef, {
        retryCount: 0, // Lower than current 1
        updatedAt: '2026-11-10T10:05:00.000Z',
      })
    );

    // Case 6: Identity modification rejected
    console.log('  Running Case 6: Perubahan identity (taskId/userId)');
    await assertFails(
      updateDoc(aliceDocRef, {
        taskId: 'forged-task-id',
        updatedAt: '2026-11-10T10:05:00.000Z',
      })
    );

    // Case 7: deletedAt timestamp modification rejected
    console.log('  Running Case 7: Perubahan deletedAt');
    await assertFails(
      updateDoc(aliceDocRef, {
        deletedAt: '2026-11-10T12:00:00.000Z',
        updatedAt: '2026-11-10T10:05:00.000Z',
      })
    );

    // Case 8: Tombstone deletion rejected
    console.log('  Running Case 8: Penghapusan dokumen tombstone');
    await assertFails(deleteDoc(aliceDocRef));

    // Case 9: Unauthorized / cross-user access rejected
    console.log('  Running Case 9: Penggunaan user yang tidak memiliki otorisasi');
    const bobAttemptRef = doc(bobDb, `users/${aliceUid}/deletion_tombstones/${tombstoneDocId}`);
    await assertFails(getDoc(bobAttemptRef));
    await assertFails(deleteDoc(bobAttemptRef));
    const unauthAttemptRef = doc(unauthDb, `users/${aliceUid}/deletion_tombstones/${tombstoneDocId}`);
    await assertFails(getDoc(unauthAttemptRef));

    // Case 10: Valid reactivation on new remote ID (cleaned -> pending_cleanup with new ID allowed)
    console.log('  Running Case 10: Transisi cleaned -> pending_cleanup dengan remote ID baru');
    await assertSucceeds(
      updateDoc(aliceDocRef, {
        status: 'pending_cleanup',
        googleCalendarEventId: 'brand-new-event-id-from-late-post',
        retryCount: 2,
        updatedAt: '2026-11-10T10:10:00.000Z',
      })
    );

    console.log('\n  🎉 SELURUH 10 KASUS PENGUJIAN FIRESTORE RULES EMULATOR SUKSES (PASS)!');
    return { status: 'PASS' };
  } finally {
    if (testEnv) {
      await testEnv.cleanup();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFirestoreRulesSuite()
    .then((res) => {
      if (res?.status === 'NOT VERIFIED') {
        process.exit(0);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ FIREBASE RULES TEST FAILURE:', err);
      process.exit(1);
    });
}
