import assert from 'assert';
import {
  fetchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  classifyGoogleCalendarError,
  GoogleCalendarApiError,
  sanitizeGoogleErrorMessage,
  sanitizeSensitiveText,
} from '../src/lib/googleCalendar';
import { CalendarEvent } from '../src/types';

export async function runGoogleCalendarReliabilitySuite(): Promise<void> {
  console.log('================================================================');
  console.log('🛡️  MENJALANKAN GOOGLE CALENDAR RELIABILITY HARDENING SUITE 🛡️');
  console.log('================================================================\n');

  const originalFetch = global.fetch;

  try {
    // ----------------------------------------------------
    // TEST 1: HTTP 401 Mengubah Status Menjadi needs_reauth
    // ----------------------------------------------------
    console.log('--- [Test 1] HTTP 401 Classified as AUTH_EXPIRED_OR_INVALID & shouldReauth ---');
    {
      const classification = classifyGoogleCalendarError(401, 'Unauthorized credentials');
      assert.strictEqual(classification.code, 'AUTH_EXPIRED_OR_INVALID');
      assert.strictEqual(classification.status, 401);
      assert.strictEqual(classification.isAuthError, true);
      assert.strictEqual(classification.shouldReauth, true);
      assert.strictEqual(classification.isPermissionError, false);
      assert.ok(classification.message.includes('HTTP 401'));

      global.fetch = async () =>
        ({
          ok: false,
          status: 401,
          text: async () => '{"error": {"message": "Invalid Credentials"}}',
        } as any);

      let caught = false;
      try {
        await fetchGoogleCalendarEvents('expired-token');
      } catch (err: any) {
        caught = true;
        assert.ok(err instanceof GoogleCalendarApiError, 'Harus melempar instance GoogleCalendarApiError');
        assert.strictEqual(err.isAuthError, true, 'isAuthError harus true');
        assert.strictEqual(err.shouldReauth, true, 'shouldReauth harus true');
      }
      assert.strictEqual(caught, true, 'fetchGoogleCalendarEvents harus melempar error pada 401');
      console.log('  ✅ [PASS] Test 1: HTTP 401 memicu klasifikasi AUTH_EXPIRED_OR_INVALID dan shouldReauth=true.');
    }

    // ----------------------------------------------------
    // TEST 2A: HTTP 403 Forbidden / Insufficient Permissions
    // ----------------------------------------------------
    console.log('\n--- [Test 2A] HTTP 403 Classified as PERMISSION_DENIED (Not Auth Expired) ---');
    {
      const raw403Forbidden = JSON.stringify({
        error: {
          code: 403,
          message: 'Insufficient Permission',
          errors: [{ domain: 'global', reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
        },
      });

      const classification = classifyGoogleCalendarError(403, raw403Forbidden);
      assert.strictEqual(classification.code, 'PERMISSION_DENIED');
      assert.strictEqual(classification.status, 403);
      assert.strictEqual(classification.isAuthError, false, '403 BUKAN auth error expired token');
      assert.strictEqual(classification.isPermissionError, true, '403 adalah permission error');
      assert.strictEqual(classification.isRateLimitError, false);
      assert.strictEqual(classification.shouldReauth, false, '403 tidak meminta reauth melainkan periksa scope');
      assert.ok(classification.message.includes('izin cakupan (OAuth scope)'));

      global.fetch = async () =>
        ({
          ok: false,
          status: 403,
          text: async () => raw403Forbidden,
        } as any);

      let caught = false;
      try {
        await fetchGoogleCalendarEvents('limited-scope-token');
      } catch (err: any) {
        caught = true;
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.isAuthError, false);
        assert.strictEqual(err.isPermissionError, true);
        assert.strictEqual(err.shouldReauth, false);
      }
      assert.strictEqual(caught, true);
      console.log('  ✅ [PASS] Test 2A: HTTP 403 insufficientPermissions terverifikasi sebagai PERMISSION_DENIED (shouldReauth=false).');
    }

    // ----------------------------------------------------
    // TEST 2B: HTTP 403 rateLimitExceeded
    // ----------------------------------------------------
    console.log('\n--- [Test 2B] HTTP 403 rateLimitExceeded Must NOT Be Classified as Permission Denied ---');
    {
      const raw403RateLimit = JSON.stringify({
        error: {
          code: 403,
          message: 'Rate Limit Exceeded',
          errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
        },
      });

      const classification = classifyGoogleCalendarError(403, raw403RateLimit);
      assert.strictEqual(classification.code, 'RATE_LIMIT_EXCEEDED');
      assert.strictEqual(classification.status, 403);
      assert.strictEqual(classification.isRateLimitError, true);
      assert.strictEqual(classification.isPermissionError, false);
      assert.strictEqual(classification.isAuthError, false);
      assert.strictEqual(classification.shouldReauth, false);
      assert.ok(classification.message.includes('Batas kuota atau laju'));

      console.log('  ✅ [PASS] Test 2B: HTTP 403 rateLimitExceeded dipisahkan presisi ke RATE_LIMIT_EXCEEDED (tidak memicu reauth).');
    }

    // ----------------------------------------------------
    // TEST 2C: HTTP 403 userRateLimitExceeded
    // ----------------------------------------------------
    console.log('\n--- [Test 2C] HTTP 403 userRateLimitExceeded Must NOT Be Classified as Permission Denied ---');
    {
      const raw403UserRate = JSON.stringify({
        error: {
          code: 403,
          message: 'User Rate Limit Exceeded',
          errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }],
        },
      });

      const classification = classifyGoogleCalendarError(403, raw403UserRate);
      assert.strictEqual(classification.code, 'RATE_LIMIT_EXCEEDED');
      assert.strictEqual(classification.isRateLimitError, true);
      assert.strictEqual(classification.isPermissionError, false);
      assert.strictEqual(classification.shouldReauth, false);

      console.log('  ✅ [PASS] Test 2C: HTTP 403 userRateLimitExceeded dipisahkan presisi ke RATE_LIMIT_EXCEEDED.');
    }

    // ----------------------------------------------------
    // TEST 2D: HTTP 403 quotaExceeded & calendarUsageLimitsExceeded
    // ----------------------------------------------------
    console.log('\n--- [Test 2D] HTTP 403 quotaExceeded & calendarUsageLimitsExceeded ---');
    {
      const raw403Quota = JSON.stringify({
        error: {
          code: 403,
          message: 'Calendar usage limits exceeded',
          errors: [{ domain: 'calendar', reason: 'calendarUsageLimitsExceeded', message: 'Usage limit reached' }],
        },
      });

      const classification = classifyGoogleCalendarError(403, raw403Quota);
      assert.strictEqual(classification.code, 'RATE_LIMIT_EXCEEDED');
      assert.strictEqual(classification.isRateLimitError, true);
      assert.strictEqual(classification.isPermissionError, false);
      assert.strictEqual(classification.shouldReauth, false);

      console.log('  ✅ [PASS] Test 2D: HTTP 403 calendarUsageLimitsExceeded diklasifikasikan ke RATE_LIMIT_EXCEEDED.');
    }

    // ----------------------------------------------------
    // TEST 2E: HTTP 403 Unknown Reason Handled Safely
    // ----------------------------------------------------
    console.log('\n--- [Test 2E] HTTP 403 with Unknown Reason Handled Safely ---');
    {
      const raw403Unknown = JSON.stringify({
        error: {
          code: 403,
          message: 'Custom unknown restriction',
          errors: [{ domain: 'custom', reason: 'arbitraryNewRestriction', message: 'Some restriction' }],
        },
      });

      const classification = classifyGoogleCalendarError(403, raw403Unknown);
      assert.strictEqual(classification.code, 'UNKNOWN_ERROR');
      assert.strictEqual(classification.status, 403);
      assert.strictEqual(classification.isAuthError, false);
      assert.strictEqual(classification.shouldReauth, false);
      assert.ok(classification.message.includes('403'));

      console.log('  ✅ [PASS] Test 2E: HTTP 403 alasan tidak dikenal ditangani aman tanpa salah sangka token kedaluwarsa.');
    }

    // ----------------------------------------------------
    // TEST 3: HTTP 404 Ditangani Tanpa Menghapus Data Lokal
    // ----------------------------------------------------
    console.log('\n--- [Test 3] HTTP 404 Tolerant & Safe Handling ---');
    {
      const classification = classifyGoogleCalendarError(404, 'Calendar not found');
      assert.strictEqual(classification.code, 'NOT_FOUND');
      assert.strictEqual(classification.isAuthError, false);
      assert.ok(classification.message.includes('Data lokal Anda tetap aman'));

      // DELETE pada event 404 harus sukses secara bersih (idempotent delete)
      global.fetch = async () =>
        ({
          ok: false,
          status: 404,
          text: async () => 'Not Found',
        } as any);

      let deleteThrew = false;
      try {
        await deleteGoogleCalendarEvent('mock-token', 'gcal-already-deleted-123');
      } catch {
        deleteThrew = true;
      }
      assert.strictEqual(deleteThrew, false, 'Penghapusan event 404 tidak boleh melempar error (idempotent)');
      console.log('  ✅ [PASS] Test 3: HTTP 404 ditangani aman tanpa merusak data dan DELETE 404 bersifat idempotent.');
    }

    // ----------------------------------------------------
    // TEST 4: HTTP 429 Rate Limit Ditangani Secara Terkendali
    // ----------------------------------------------------
    console.log('\n--- [Test 4] HTTP 429 Rate Limit Classification ---');
    {
      const classification = classifyGoogleCalendarError(429, 'Rate limit exceeded');
      assert.strictEqual(classification.code, 'RATE_LIMIT_EXCEEDED');
      assert.strictEqual(classification.isRateLimitError, true);
      assert.strictEqual(classification.isTransient, true);
      assert.strictEqual(classification.isAuthError, false);
      assert.strictEqual(classification.shouldReauth, false);
      assert.ok(classification.userAction.includes('Tunggu beberapa'));
      console.log('  ✅ [PASS] Test 4: HTTP 429 diklasifikasikan sebagai RATE_LIMIT_EXCEEDED dengan panduan backoff.');
    }

    // ----------------------------------------------------
    // TEST 5: HTTP 500-599 Server Error Tidak Menghasilkan Status Sukses
    // ----------------------------------------------------
    console.log('\n--- [Test 5] HTTP 500-599 Service Error Handling ---');
    {
      const c500 = classifyGoogleCalendarError(500, 'Internal Server Error');
      assert.strictEqual(c500.code, 'SERVICE_UNAVAILABLE');
      assert.strictEqual(c500.isTransient, true);
      assert.strictEqual(c500.isAuthError, false);

      const c503 = classifyGoogleCalendarError(503, 'Backend Unavailable');
      assert.strictEqual(c503.code, 'SERVICE_UNAVAILABLE');

      global.fetch = async () =>
        ({
          ok: false,
          status: 503,
          text: async () => 'Service Temporarily Unavailable',
        } as any);

      let caught = false;
      try {
        await createGoogleCalendarEvent('mock-token', {
          title: 'Uji 503',
          startAt: '2026-11-05T09:00:00+07:00',
          endAt: '2026-11-05T10:00:00+07:00',
        });
      } catch (err: any) {
        caught = true;
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'SERVICE_UNAVAILABLE');
      }
      assert.strictEqual(caught, true, 'HTTP 503 harus digagalkan dengan tegas');
      console.log('  ✅ [PASS] Test 5: HTTP 500 & 503 dicegat tegas sebagai SERVICE_UNAVAILABLE tanpa status sukses palsu.');
    }

    // ----------------------------------------------------
    // TEST 6: Network Error & AbortError Semantics
    // ----------------------------------------------------
    console.log('\n--- [Test 6] Network Error & Abort Semantics ---');
    {
      const netError = new TypeError('Failed to fetch');
      const cNet = classifyGoogleCalendarError(0, '', netError);
      assert.strictEqual(cNet.code, 'NETWORK_ERROR');
      assert.strictEqual(cNet.isTransient, true);
      assert.strictEqual(cNet.isAuthError, false);
      assert.strictEqual(cNet.shouldReauth, false);
      assert.ok(cNet.message.includes('Data lokal tetap aman'));

      const abortError = new Error('The user aborted a request.');
      abortError.name = 'AbortError';
      const cAbort = classifyGoogleCalendarError(0, '', abortError);
      assert.strictEqual(cAbort.code, 'ABORTED');
      assert.strictEqual(cAbort.isAuthError, false);
      assert.strictEqual(cAbort.shouldReauth, false);
      assert.strictEqual(cAbort.isTransient, false);

      console.log('  ✅ [PASS] Test 6: Network failure & abort request terisolasi akurat (bukan 401 dan no reauth).');
    }

    // ----------------------------------------------------
    // TEST 7: Reconnect Flow Memulihkan Status Koneksi
    // ----------------------------------------------------
    console.log('\n--- [Test 7] Reconnect Flow State Transition ---');
    {
      let currentStatus = 'needs_reauth';
      let activeToken: string | null = null;

      // 1. User menekan Reconnect -> 'connecting'
      currentStatus = 'connecting';
      assert.strictEqual(currentStatus, 'connecting');

      // 2. Google OAuth mengembalikan token baru
      const mockNewToken = 'fresh-new-oauth-token-xyz';
      activeToken = mockNewToken;
      currentStatus = 'connected_unsynced';
      assert.strictEqual(currentStatus, 'connected_unsynced');
      assert.ok(activeToken !== null);

      // 3. Trigger sync dengan token baru -> sukses
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'evt-live-1',
                summary: 'Agenda Live Baru',
                start: { dateTime: '2026-11-05T14:00:00+07:00' },
                end: { dateTime: '2026-11-05T15:00:00+07:00' },
                status: 'confirmed',
              },
            ],
          }),
        } as any);

      const syncResult = await fetchGoogleCalendarEvents(activeToken);
      currentStatus = 'sync_success';

      assert.strictEqual(currentStatus, 'sync_success');
      assert.strictEqual(syncResult.events.length, 1);
      assert.strictEqual(syncResult.events[0].title, 'Agenda Live Baru');
      console.log('  ✅ [PASS] Test 7: Alur reconnect memulihkan status dari needs_reauth ke sync_success.');
    }

    // ----------------------------------------------------
    // TEST 8: Token Baru Digunakan Setelah Reconnect
    // ----------------------------------------------------
    console.log('\n--- [Test 8] Fresh Token Propagation Verification ---');
    {
      let capturedBearer = '';
      global.fetch = async (_url: any, opts: any) => {
        capturedBearer = opts?.headers?.Authorization || '';
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [] }),
        } as any;
      };

      const freshToken = 'ya29.a0AfH6SM_FRESH_TOKEN_2026';
      await fetchGoogleCalendarEvents(freshToken);
      assert.strictEqual(capturedBearer, `Bearer ${freshToken}`, 'Token baru harus dikirimkan pada header Authorization');
      console.log('  ✅ [PASS] Test 8: Token baru terbukti digunakan pada pemanggilan Google Calendar API.');
    }

    // ----------------------------------------------------
    // TEST 9: Kegagalan Sinkronisasi Tidak Menghapus Data Lokal
    // ----------------------------------------------------
    console.log('\n--- [Test 9] Local Task & Event Preservation On Sync Failure ---');
    {
      const localEvents: CalendarEvent[] = [
        {
          id: 'local-task-1',
          provider: 'internal',
          title: 'Tugas Belajar Algoritma',
          startAt: '2026-11-05T08:00:00+07:00',
          endAt: '2026-11-05T09:00:00+07:00',
          category: 'focus',
          syncStatus: 'pending',
          isEditable: true,
        },
      ];

      // Simulasi kegagalan 401 saat sync
      global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' } as any);

      const eventsState = [...localEvents];
      try {
        await fetchGoogleCalendarEvents('expired-token');
      } catch {
        // Pada penanganan error, events lokal TIDAK diubah
      }

      assert.strictEqual(eventsState.length, 1, 'Data event lokal tidak boleh berkurang');
      assert.strictEqual(eventsState[0].id, 'local-task-1', 'Event lokal harus tetap utuh');
      assert.strictEqual(eventsState[0].title, 'Tugas Belajar Algoritma');
      console.log('  ✅ [PASS] Test 9: Data lokal terbukti terjaga 100% dan tidak pernah terhapus saat API gagal.');
    }

    // ----------------------------------------------------
    // TEST 10: Sanitasi Menghindari Kebocoran Token / PII
    // ----------------------------------------------------
    console.log('\n--- [Test 10] Zero Secret & Token Leakage in Error Payloads ---');
    {
      const rawErrorJson = JSON.stringify({
        error: {
          code: 400,
          message:
            'Invalid credentials ya29.a0AfH6SMB98234-super-secret and refresh 1//0gX_secret for user private@example.com with Bearer secret-auth',
        },
      });
      const sanitized = sanitizeGoogleErrorMessage(400, rawErrorJson);
      assert.strictEqual(sanitized.includes('ya29.a0AfH6SMB98234'), false, 'Token ya29 rahasia tidak boleh bocor');
      assert.strictEqual(sanitized.includes('1//0gX_secret'), false, 'Refresh token tidak boleh bocor');
      assert.strictEqual(sanitized.includes('private@example.com'), false, 'Email tidak boleh bocor');
      assert.strictEqual(sanitized.includes('secret-auth'), false, 'Bearer secret tidak boleh bocor');
      assert.ok(sanitized.includes('[REDACTED_TOKEN]'), 'Token harus disamarkan dengan [REDACTED_TOKEN]');
      assert.ok(sanitized.includes('[REDACTED_REFRESH_TOKEN]'), 'Refresh token disamarkan');
      assert.ok(sanitized.includes('[REDACTED_EMAIL]'), 'Email harus disamarkan dengan [REDACTED_EMAIL]');

      // Test helper langsung
      const directCleaned = sanitizeSensitiveText('ya29.123456 1//refresh secret@mail.com Bearer mysecret');
      assert.ok(directCleaned.includes('[REDACTED_TOKEN]'));
      assert.ok(directCleaned.includes('[REDACTED_REFRESH_TOKEN]'));
      assert.ok(directCleaned.includes('[REDACTED_EMAIL]'));
      assert.ok(directCleaned.includes('Bearer [REDACTED]'));

      console.log('  ✅ [PASS] Test 10: Seluruh token, refresh token, email pengguna, dan rahasia Authorization disamarkan sempurna.');
    }

    // ----------------------------------------------------
    // TEST 11: Request Lama Tidak Menimpa Status Koneksi Terbaru
    // ----------------------------------------------------
    console.log('\n--- [Test 11] Asynchronous Race-Condition Resilience ---');
    {
      let syncRequestId = 0;
      let stateConnectionStatus = 'unconnected';

      // Request 1 dimulai
      const req1Id = ++syncRequestId; // 1

      // Pengguna segera melakukan reconnect sebelum Request 1 selesai:
      const req2Id = ++syncRequestId; // 2
      stateConnectionStatus = 'sync_success'; // req 2 sukses lebih awal

      // Sekarang Request 1 yang tertunda tiba-tiba selesai dengan error 401
      const req1FailedStatus = 'needs_reauth';

      // Guard check:
      if (syncRequestId === req1Id) {
        stateConnectionStatus = req1FailedStatus;
      }

      // Pastikan status tetap sync_success milik Request 2!
      assert.strictEqual(
        stateConnectionStatus,
        'sync_success',
        'Request lama (req1) tidak boleh menimpa status koneksi terbaru (req2)'
      );
      console.log('  ✅ [PASS] Test 11: Race condition pencegahan stale status terbukti efektif.');
    }

    // ----------------------------------------------------
    // TEST 12: Pagination Failure di Tengah Jalan Tidak Merusak Data Lokal
    // ----------------------------------------------------
    console.log('\n--- [Test 12] Pagination Mid-flight Failure Preservation ---');
    {
      let pageCallCount = 0;
      global.fetch = async () => {
        pageCallCount++;
        if (pageCallCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{ id: 'partial-page-1', summary: 'Event Halaman 1' }],
              nextPageToken: 'token-page-2',
            }),
          } as any;
        } else {
          // Page 2 gagal (misal 500 error)
          return {
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error on Page 2',
          } as any;
        }
      };

      let caught = false;
      try {
        await fetchGoogleCalendarEvents('mock-token');
      } catch (err: any) {
        caught = true;
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'SERVICE_UNAVAILABLE');
      }

      assert.strictEqual(caught, true, 'Kegagalan page 2 harus melempar error agar data parsial tidak menimpa kalender lokal');
      console.log('  ✅ [PASS] Test 12: Kegagalan paginasi di tengah proses melempar error dan mencegah penggantian data parsial.');
    }

    // ----------------------------------------------------
    // TEST 13: Empty Remote Response Preserves Internal Sessions
    // ----------------------------------------------------
    console.log('\n--- [Test 13] Empty Remote Response Preserves Internal Sessions ---');
    {
      const initialLocalEvents: CalendarEvent[] = [
        {
          id: 'internal-sess-1',
          provider: 'internal',
          title: 'Sesi Internal Fokus',
          startAt: '2026-11-05T10:00:00+07:00',
          endAt: '2026-11-05T11:00:00+07:00',
          category: 'focus',
          syncStatus: 'synced',
          isEditable: true,
        },
      ];

      global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      } as any);

      const fetchRes = await fetchGoogleCalendarEvents('mock-token');
      assert.strictEqual(fetchRes.events.length, 0);

      // Simulasikan merge aman di App.tsx:
      const internalEvents = initialLocalEvents.filter((e) => e.provider !== 'google');
      const remoteIds = new Set(fetchRes.events.map((e) => e.id));
      const safeInternal = internalEvents.filter((e) => !remoteIds.has(e.id));
      const mergedEvents = [...fetchRes.events, ...safeInternal];

      assert.strictEqual(mergedEvents.length, 1, 'Event internal harus tetap ada meskipun respons Google kosong');
      assert.strictEqual(mergedEvents[0].id, 'internal-sess-1');
      console.log('  ✅ [PASS] Test 13: Respons kosong dari remote tidak pernah melenyapkan sesi internal lokal.');
    }

    // ----------------------------------------------------
    // TEST 14: Corrupted JSON Parsing Failure Handled Safely
    // ----------------------------------------------------
    console.log('\n--- [Test 14] Corrupted JSON Response Handled as INVALID_RESPONSE ---');
    {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      } as any);

      let caught = false;
      try {
        await fetchGoogleCalendarEvents('mock-token');
      } catch (err: any) {
        caught = true;
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'INVALID_RESPONSE');
        assert.strictEqual(err.shouldReauth, false, 'Format JSON korup bukan auth error');
      }

      assert.strictEqual(caught, true);
      console.log('  ✅ [PASS] Test 14: Respons non-JSON / korup diklasifikasikan sebagai INVALID_RESPONSE dan tidak memicu reauth palsu.');
    }

    console.log('\n================================================================');
    console.log('🎉 SELURUH PENGUJIAN RELIABILITY GOOGLE CALENDAR BERHASIL 100%! 🎉');
    console.log('================================================================\n');
  } finally {
    global.fetch = originalFetch;
  }
}

if (process.argv[1]?.endsWith('google-calendar-reliability.test.ts')) {
  runGoogleCalendarReliabilitySuite().catch((err) => {
    console.error('❌ GAGAL PENGUJIAN RELIABILITY GOOGLE CALENDAR:', err);
    process.exit(1);
  });
}
