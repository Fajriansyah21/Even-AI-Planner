import {
  classifyGeminiError,
  executeWithRetryAndTimeout,
  calculateBackoffWithJitter,
  formatUserErrorMessage,
} from '../src/lib/geminiErrorHandling';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

async function runGeminiErrorHandlingTests() {
  console.log('=== RUNNING GEMINI ERROR HANDLING & RETRY TESTS ===\n');

  // ----------------------------------------------------
  // TEST 1: Simulate Gemini 503 (Overloaded) -> Exactly 3 attempts total (initial + 2 retries)
  // ----------------------------------------------------
  console.log('--- Test 1: Simulate Gemini 503 (Overloaded) -> Max 3 attempts total ---');
  let attemptCount503 = 0;
  const mockSleep = async (_ms: number) => {
    // immediate sleep for fast unit tests
  };

  const res503 = await executeWithRetryAndTimeout(
    async (attempt) => {
      attemptCount503++;
      const err = new Error(`Attempt ${attempt}: 503 UNAVAILABLE - The model is overloaded. Please try again later.`);
      (err as any).status = 503;
      throw err;
    },
    {
      maxRetries: 2,
      totalTimeoutMs: 15000,
      initialBackoffMs: 10,
      sleepFn: mockSleep,
    }
  );

  assert(attemptCount503 === 3, `Expected exactly 3 total attempts for 503, got ${attemptCount503}`);
  assert(res503.retryCount === 2, `Expected 2 retries recorded, got ${res503.retryCount}`);
  assert(Boolean(res503.error), 'Expected error to be returned after exhaustion');
  assert(res503.analysis?.status === 503, `Expected status 503, got ${res503.analysis?.status}`);
  assert(
    res503.analysis?.errorCode === 'AI_TEMPORARILY_UNAVAILABLE',
    `Expected AI_TEMPORARILY_UNAVAILABLE, got ${res503.analysis?.errorCode}`
  );
  assert(
    res503.analysis?.userMessage === 'Layanan AI sedang sibuk. Permintaan Anda belum diproses. Silakan coba lagi.',
    'User message must be the specified friendly Indonesian text'
  );

  // ----------------------------------------------------
  // TEST 2: Simulate 400 and 403 Permanent Errors -> Exactly 1 attempt (NO RETRIES)
  // ----------------------------------------------------
  console.log('\n--- Test 2: Simulate 400 & 403 -> Exactly 1 attempt, no unnecessary retries ---');
  let attemptCount400 = 0;
  const res400 = await executeWithRetryAndTimeout(
    async () => {
      attemptCount400++;
      const err = new Error('400 INVALID_ARGUMENT: Invalid input prompt');
      (err as any).status = 400;
      throw err;
    },
    { maxRetries: 2, sleepFn: mockSleep }
  );

  assert(attemptCount400 === 1, `400 Bad Request must abort immediately on 1st attempt, got ${attemptCount400}`);
  assert(res400.analysis?.status === 400, 'Expected status 400');
  assert(res400.analysis?.isRetryable === false, '400 must NOT be retryable');
  assert(res400.analysis?.errorCode === 'AI_INVALID_REQUEST', 'Expected AI_INVALID_REQUEST');

  let attemptCount403 = 0;
  const res403 = await executeWithRetryAndTimeout(
    async () => {
      attemptCount403++;
      const err = new Error('403 PERMISSION_DENIED: The caller does not have permission');
      (err as any).status = 403;
      throw err;
    },
    { maxRetries: 2, sleepFn: mockSleep }
  );

  assert(attemptCount403 === 1, `403 Forbidden must abort immediately on 1st attempt, got ${attemptCount403}`);
  assert(res403.analysis?.status === 403, 'Expected status 403');
  assert(res403.analysis?.isRetryable === false, '403 must NOT be retryable');
  assert(res403.analysis?.errorCode === 'AI_PERMISSION_DENIED', 'Expected AI_PERMISSION_DENIED');

  // ----------------------------------------------------
  // TEST 3: Simulate Transient Failure with Successful Recovery on 2nd Try
  // ----------------------------------------------------
  console.log('\n--- Test 3: Transient 503 recovery on 2nd attempt ---');
  let attemptCountRecover = 0;
  const resRecover = await executeWithRetryAndTimeout(
    async (attempt) => {
      attemptCountRecover++;
      if (attempt === 0) {
        const err = new Error('503 UNAVAILABLE');
        (err as any).status = 503;
        throw err;
      }
      return { success: true, text: '{"title": "Belajar React"}' };
    },
    { maxRetries: 2, sleepFn: mockSleep }
  );

  assert(attemptCountRecover === 2, `Expected 2 attempts before success, got ${attemptCountRecover}`);
  assert(resRecover.retryCount === 1, `Expected 1 retry, got ${resRecover.retryCount}`);
  assert(resRecover.result?.success === true, 'Operation must return successful result');

  // ----------------------------------------------------
  // TEST 4: Timeout Detection and Status 504
  // ----------------------------------------------------
  console.log('\n--- Test 4: Timeout Detection -> Status 504 & AI_TIMEOUT ---');
  const timeoutErr = new Error('Permintaan ke Gemini API melampaui batas waktu (timeout 15 detik).');
  (timeoutErr as any).name = 'AbortError';

  const timeoutAnalysis = classifyGeminiError(timeoutErr);
  assert(timeoutAnalysis.status === 504, `Timeout must map to HTTP 504, got ${timeoutAnalysis.status}`);
  assert(timeoutAnalysis.errorCode === 'AI_TIMEOUT', `Expected AI_TIMEOUT, got ${timeoutAnalysis.errorCode}`);
  assert(timeoutAnalysis.isRetryable === true, 'Timeout should be retryable within budget');

  // ----------------------------------------------------
  // TEST 5: formatUserErrorMessage Sanitization & No Raw JSON
  // ----------------------------------------------------
  console.log('\n--- Test 5: formatUserErrorMessage Sanitization ---');
  const rawJsonLeak = '{"error": {"code": 503, "message": "The model is overloaded. Please try again later.", "status": "UNAVAILABLE"}}';
  const sanitizedMsg = formatUserErrorMessage('AI_TEMPORARILY_UNAVAILABLE', 503, rawJsonLeak);

  assert(
    sanitizedMsg === 'Layanan AI sedang sibuk. Permintaan Anda belum diproses. Silakan coba lagi.',
    'Must return clean Indonesian message instead of raw JSON'
  );
  assert(!sanitizedMsg.includes('{'), 'Must not contain any JSON brackets');
  assert(!sanitizedMsg.includes('UNAVAILABLE'), 'Must not leak internal error constants');

  const rawJsonLeakWithoutCode = formatUserErrorMessage(undefined, undefined, rawJsonLeak);
  assert(!rawJsonLeakWithoutCode.includes('{'), 'Must not leak raw JSON even without errorCode');

  // ----------------------------------------------------
  // TEST 6: Exponential Backoff Calculation
  // ----------------------------------------------------
  console.log('\n--- Test 6: Exponential Backoff with Jitter ---');
  const b1 = calculateBackoffWithJitter(1, 400, 2000);
  const b2 = calculateBackoffWithJitter(2, 400, 2000);
  assert(b1 >= 200 && b1 <= 600, `Backoff attempt 1 must be within [200, 600], got ${b1}`);
  assert(b2 >= 400 && b2 <= 1200, `Backoff attempt 2 must be within [400, 1200], got ${b2}`);

  console.log('\n======================================================');
  console.log('🎉 ALL GEMINI ERROR HANDLING & RETRY TESTS PASSED! 🎉');
  console.log('======================================================\n');
}

runGeminiErrorHandlingTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
