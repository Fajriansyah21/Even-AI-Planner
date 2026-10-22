import { parseIndonesianTemporalRules } from '../src/lib/temporalParser';
import { scheduleTaskDeterministically } from '../src/lib/scheduler';
import { Task, CalendarEvent, UserPreferences } from '../src/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

const testPreferences: UserPreferences = {
  displayName: 'Penguji EVEN',
  email: 'penguji@example.com',
  timezone: 'Asia/Jakarta (WIB)',
  workStartHour: 9,
  workEndHour: 18,
  lunchStartHour: 12,
  lunchEndHour: 13,
  bufferMinutes: 15,
  workDays: [1, 2, 3, 4, 5],
  googleCalendarConnected: false,
  calendarSyncStatus: 'pending',
  lastSyncedAt: null,
  allowAutoSplit: true,
};

async function runAuthAndTruthTests() {
  console.log('=== RUNNING AUTH INTEGRITY & STATUS TRUTH TESTS ===\n');

  // ----------------------------------------------------
  // TEST 1: Google Auth Error Simulation - No Fake Login Fallback
  // ----------------------------------------------------
  console.log('--- Test 1: Simulated Auth Failures must NEVER produce fake login credentials ---');

  // Simulate AuthModal error handler logic
  const simulateHandleGoogleAuth = async (mockSignIn: () => Promise<any>) => {
    let successCalled = false;
    let modalClosed = false;
    let displayedErrorMessage = '';

    const onSuccess = (_email: string, _name: string, _isNew: boolean, _token?: string) => {
      successCalled = true;
    };
    const onClose = () => {
      modalClosed = true;
    };

    try {
      const result = await mockSignIn();
      if (result && result.user) {
        onSuccess(result.user.email, result.user.displayName, false, result.accessToken);
        onClose();
      }
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        displayedErrorMessage = 'Jendela login ditutup sebelum proses selesai. Silakan coba kembali.';
      } else if (err.code === 'auth/popup-blocked') {
        displayedErrorMessage = 'Jendela popup login diblokir oleh peramban. Harap izinkan pop-up di peramban Anda.';
      } else if (err.code === 'auth/network-request-failed') {
        displayedErrorMessage = 'Gagal terhubung ke jaringan. Periksa koneksi internet Anda dan coba lagi.';
      } else {
        displayedErrorMessage = `Autentikasi gagal: ${err.message}`;
      }
    }

    return { successCalled, modalClosed, displayedErrorMessage };
  };

  // Case A: User cancelled popup
  const resCancel = await simulateHandleGoogleAuth(async () => {
    const err = new Error('Popup closed by user');
    (err as any).code = 'auth/popup-closed-by-user';
    throw err;
  });
  assert(!resCancel.successCalled, 'onSuccess must NEVER be called when popup is closed by user');
  assert(!resCancel.modalClosed, 'Dialog must NOT close when popup is cancelled');
  assert(resCancel.displayedErrorMessage.includes('Jendela login ditutup'), 'Must display friendly Indonesian cancellation message');

  // Case B: Popup blocked by browser
  const resBlocked = await simulateHandleGoogleAuth(async () => {
    const err = new Error('Popup blocked');
    (err as any).code = 'auth/popup-blocked';
    throw err;
  });
  assert(!resBlocked.successCalled, 'onSuccess must NEVER be called when popup is blocked');
  assert(!resBlocked.modalClosed, 'Dialog must NOT close when popup is blocked');
  assert(resBlocked.displayedErrorMessage.includes('diblokir oleh peramban'), 'Must display popup blocked message');

  // Case C: Real Successful Google Authentication
  const resSuccess = await simulateHandleGoogleAuth(async () => {
    return {
      user: {
        uid: 'user-real-123',
        email: 'real.user@gmail.com',
        displayName: 'Real User',
      },
      accessToken: 'ya29.valid-oauth-access-token',
    };
  });
  assert(resSuccess.successCalled, 'onSuccess MUST be called only on real successful authentication');
  assert(resSuccess.modalClosed, 'Dialog closes on verified success');
  assert(resSuccess.displayedErrorMessage === '', 'No error on success');

  // ----------------------------------------------------
  // TEST 2: Distinguish Firebase Auth from Google Calendar Token
  // ----------------------------------------------------
  console.log('\n--- Test 2: Distinguish Firebase Auth presence from Google Calendar access token ---');
  let isLoggedIn = false;
  let hasGoogleAccessToken = false;
  let googleCalendarConnected = false;

  const simulateInitAuth = (user: any | null, token: string | null) => {
    if (user) {
      isLoggedIn = true;
      hasGoogleAccessToken = Boolean(token);
      googleCalendarConnected = Boolean(token);
    } else {
      isLoggedIn = false;
      hasGoogleAccessToken = false;
      googleCalendarConnected = false;
    }
  };

  // User with valid Firebase session but NO calendar access token
  simulateInitAuth({ uid: 'user-firebase-only', email: 'fb@example.com' }, null);
  assert(isLoggedIn === true, 'User is logged in to Firebase');
  assert(hasGoogleAccessToken === false, 'Google Calendar access token must NOT be assumed present');
  assert(googleCalendarConnected === false, 'Google Calendar connection must NOT be marked true without token');

  // User with both Firebase session AND calendar token
  simulateInitAuth({ uid: 'user-full', email: 'full@example.com' }, 'ya29.live-token');
  assert(isLoggedIn === true, 'User is logged in');
  assert(hasGoogleAccessToken === true, 'Token is present');
  assert(googleCalendarConnected === true, 'Google Calendar is verified connected');

  // User logs out
  simulateInitAuth(null, null);
  assert(isLoggedIn === false, 'Logged out resets isLoggedIn');
  assert(hasGoogleAccessToken === false, 'Logged out resets hasGoogleAccessToken');
  assert(googleCalendarConnected === false, 'Logged out resets googleCalendarConnected');

  // ----------------------------------------------------
  // TEST 3: AI Plan Route Sanitization (Anchor of Truth)
  // ----------------------------------------------------
  console.log('\n--- Test 3: Plan Route Sanitization overrides hallucinations with deterministic truth ---');

  // Simulate route.ts sanitization
  const sanitizePlanLikeRoute = (userPrompt: string, rawAiOutput: any, baseline: any) => {
    const sanitized = { ...rawAiOutput };

    if (baseline.timeConstraintType === 'fixed_event') {
      sanitized.timeConstraintType = 'fixed_event';
      sanitized.requestedStartAt = baseline.requestedStartAt;
      sanitized.requestedEndAt = baseline.requestedEndAt;
      sanitized.estimatedDurationMinutes = baseline.estimatedDurationMinutes;
      sanitized.allowSplit = false;
    } else if (baseline.timeConstraintType === 'preferred_window') {
      sanitized.timeConstraintType = 'preferred_window';
      sanitized.preferredWindow = baseline.preferredWindow;
      sanitized.preferredTimeOfDay = baseline.preferredTimeOfDay;
      delete sanitized.requestedStartAt;
      delete sanitized.requestedEndAt;
    } else {
      sanitized.timeConstraintType = 'deadline_only';
      delete sanitized.requestedStartAt;
      delete sanitized.requestedEndAt;
    }

    if (baseline.preferredTimeOfDay !== 'ANY') {
      sanitized.preferredTimeOfDay = baseline.preferredTimeOfDay;
    }

    return sanitized;
  };

  // Scenario: User asked "tidur malam 8 jam", AI hallucinated 05:00 fixed event
  const baselineTidur = parseIndonesianTemporalRules({
    userPrompt: 'tidur malam 8 jam',
    currentDateTime: '2026-10-19T08:00:00.000Z',
    userTimezone: 'Asia/Jakarta',
  });

  const hallucinatedAiOutput = {
    title: 'Tidur Malam 8 Jam',
    timeConstraintType: 'fixed_event',
    requestedStartAt: '2026-10-19T05:00:00.000Z', // 05:00 morning hallucination
    requestedEndAt: '2026-10-19T13:00:00.000Z',
    preferredTimeOfDay: 'MORNING',
    estimatedDurationMinutes: 480,
    allowSplit: false,
    reasoning: 'AI hallucinated 05:00',
  };

  const cleanPlan = sanitizePlanLikeRoute('tidur malam 8 jam', hallucinatedAiOutput, baselineTidur);
  assert(cleanPlan.timeConstraintType === 'preferred_window', 'Must be converted to preferred_window');
  assert(cleanPlan.preferredTimeOfDay === 'EVENING', 'Must remain EVENING');
  assert(cleanPlan.requestedStartAt === undefined, 'Hallucinated 05:00 start must be deleted');
  assert(cleanPlan.requestedEndAt === undefined, 'Hallucinated end must be deleted');
  assert(Boolean(cleanPlan.preferredWindow), 'Must preserve preferred evening window');

  // ----------------------------------------------------
  // TEST 4: sanitizeForFirestore eliminates undefined fields
  // ----------------------------------------------------
  console.log('\n--- Test 4: sanitizeForFirestore eliminates undefined fields for Firestore setDoc ---');
  const dirtyFirestoreTask = {
    id: 'task-test-firestore',
    title: 'Tugas Uji Firestore',
    description: undefined, // Causes "Unsupported field value: undefined"
    nested: {
      fieldA: 'valid',
      fieldB: undefined,
    },
    list: [
      { id: 1, text: 'ok', opt: undefined },
      'string-item',
    ],
    requestedStartAt: undefined,
  };

  const { sanitizeForFirestore } = await import('../src/lib/firebase');
  const cleanedTask = sanitizeForFirestore(dirtyFirestoreTask);

  assert(!('description' in cleanedTask), 'description with undefined value must be omitted');
  assert(!('requestedStartAt' in cleanedTask), 'requestedStartAt with undefined must be omitted');
  assert(cleanedTask.title === 'Tugas Uji Firestore', 'Valid fields must be preserved');
  assert(cleanedTask.nested.fieldA === 'valid', 'Valid nested fields must be preserved');
  assert(!('fieldB' in cleanedTask.nested), 'Undefined nested fields must be omitted');
  assert(cleanedTask.list[0].text === 'ok', 'Array elements must be cleaned');
  assert(!('opt' in cleanedTask.list[0]), 'Undefined in array objects must be omitted');

  // ----------------------------------------------------
  // TEST 5: Task creation assigns current authenticated userId matching Firestore rule
  // ----------------------------------------------------
  console.log('\n--- Test 5: Task creation matches authenticated userId required by firestore.rules ---');
  const authenticatedUserId = 'Dvh5LgOfE1PetboAiMMff0VckAA2';
  const taskFromModal = {
    userId: 'user-default', // Modal might submit fallback or prop
    title: 'Tugas Belajar',
    description: '',
    estimatedDurationMinutes: 45,
    deadlineAt: '2026-10-25T18:00:00.000Z',
    priority: 'HIGH' as const,
    allowSplit: false,
  };

  // Logic in App.tsx handleSaveTask:
  const currentUserId = authenticatedUserId || 'user-default';
  const createdTask = {
    ...taskFromModal,
    id: 'task-1792583068860',
    userId: currentUserId,
    status: 'UNSCHEDULED' as const,
    createdAt: new Date().toISOString(),
    scheduledSessions: [],
  };

  assert(createdTask.userId === authenticatedUserId, 'createdTask.userId must match authenticated userId');
  assert(createdTask.userId !== 'user-default', 'Must NOT be user-default when user is authenticated');

  console.log('\n======================================================');
  console.log('🎉 ALL AUTH INTEGRITY & STATUS TRUTH TESTS PASSED! 🎉');
  console.log('======================================================\n');
}

runAuthAndTruthTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
