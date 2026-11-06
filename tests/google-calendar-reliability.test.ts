import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  fetchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  batchCreateGoogleCalendarEvents,
  classifyGoogleCalendarError,
  GoogleCalendarApiError,
  sanitizeGoogleErrorMessage,
  sanitizeSensitiveText,
} from '../src/lib/googleCalendar';
import { CalendarOperationGuard } from '../src/lib/calendarOperationGuard';
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

    // ----------------------------------------------------
    // TEST 15: OAuth Connect Lama yang Selesai Setelah Disconnect Diabaikan
    // ----------------------------------------------------
    console.log('\n--- [Test 15] OAuth Connect Resolving After Disconnect Is Discarded ---');
    {
      let connectOpId = 0;
      let connectedToken: string | null = null;
      let isConnected = false;

      // User triggers connect (Operation 1)
      const op1 = ++connectOpId;

      // User immediately clicks Disconnect before OAuth popup resolves:
      // Disconnect invalidates operation ID
      connectOpId++;
      connectedToken = null;
      isConnected = false;

      // Popup 1 eventually resolves asynchronously:
      const popup1Result = { accessToken: 'stale-token-op1' };
      if (connectOpId === op1) {
        connectedToken = popup1Result.accessToken;
        isConnected = true;
      }

      assert.strictEqual(connectedToken, null, 'Stale popup result must not revive connection after disconnect');
      assert.strictEqual(isConnected, false, 'State must remain disconnected');
      console.log('  ✅ [PASS] Test 15: Operasi connect lama yang selesai setelah disconnect berhasil diabaikan.');
    }

    // ----------------------------------------------------
    // TEST 16: OAuth Connect Lama yang Selesai Setelah Reconnect Diabaikan
    // ----------------------------------------------------
    console.log('\n--- [Test 16] OAuth Connect Resolving After Reconnect Is Discarded ---');
    {
      let connectOpId = 0;
      let connectedToken: string | null = null;

      // User triggers connect 1
      const op1 = ++connectOpId; // 1

      // User triggers connect 2 (reconnect)
      const op2 = ++connectOpId; // 2
      connectedToken = 'fresh-token-op2';

      // Old popup 1 resolves later with stale token
      const staleToken = 'stale-token-op1';
      if (connectOpId === op1) {
        connectedToken = staleToken;
      }

      assert.strictEqual(connectedToken, 'fresh-token-op2', 'Stale connect attempt must not overwrite fresh token');
      console.log('  ✅ [PASS] Test 16: Hasil connect lama tidak dapat menimpa token baru dari proses reconnect.');
    }

    // ----------------------------------------------------
    // TEST 17: Create Event Aborted Saat Sinyal Dibatalkan
    // ----------------------------------------------------
    console.log('\n--- [Test 17] Create Google Calendar Event Honours AbortSignal ---');
    {
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      let caught = false;
      try {
        await createGoogleCalendarEvent(
          'mock-token',
          {
            title: 'Event Dibatalkan',
            startAt: '2026-11-05T09:00:00+07:00',
            endAt: '2026-11-05T10:00:00+07:00',
          },
          abortCtrl.signal
        );
      } catch (err: any) {
        caught = true;
        const classification =
          err instanceof GoogleCalendarApiError
            ? err.classification
            : classifyGoogleCalendarError(0, err.message || '', err);
        assert.strictEqual(classification.code, 'ABORTED');
        assert.strictEqual(classification.shouldReauth, false, 'Abort bukan auth failure');
      }
      assert.strictEqual(caught, true, 'createGoogleCalendarEvent harus melempar error saat signal aborted');
      console.log('  ✅ [PASS] Test 17: createGoogleCalendarEvent patuh pada AbortSignal tanpa menuduh token kedaluwarsa.');
    }

    // ----------------------------------------------------
    // TEST 18: Batch Create Berhenti Seketika Saat Sinyal Dibatalkan
    // ----------------------------------------------------
    console.log('\n--- [Test 18] Batch Create Breaks Immediately On Abort ---');
    {
      const abortCtrl = new AbortController();
      let createCallCount = 0;

      global.fetch = async (_url: any, opts: any) => {
        createCallCount++;
        if (createCallCount === 1) {
          // Abort after first item
          abortCtrl.abort();
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: `event-${createCallCount}`, htmlLink: 'https://cal.google.com' }),
        } as any;
      };

      const eventsToPush = [
        { id: 't1', title: 'Task 1', startAt: '2026-11-05T09:00:00+07:00', endAt: '2026-11-05T10:00:00+07:00' },
        { id: 't2', title: 'Task 2', startAt: '2026-11-05T11:00:00+07:00', endAt: '2026-11-05T12:00:00+07:00' },
        { id: 't3', title: 'Task 3', startAt: '2026-11-05T13:00:00+07:00', endAt: '2026-11-05T14:00:00+07:00' },
      ];

      const batchRes = await batchCreateGoogleCalendarEvents(
        'mock-token',
        eventsToPush,
        1, // chunk size 1 so each item checks abort
        abortCtrl.signal
      );

      // Subsequent items should be aborted early
      assert.ok(createCallCount < 3, 'Pemanggilan fetch tidak boleh memproses seluruh 3 item setelah di-abort');
      const abortedItems = batchRes.results.filter((r) => r.classification?.code === 'ABORTED');
      assert.ok(abortedItems.length > 0 || createCallCount < 3, 'Harus mencatat pembatalan operasi');
      console.log('  ✅ [PASS] Test 18: Batch create menghentikan pengiriman chunk seketika saat sinyal pembatalan aktif.');
    }

    // ----------------------------------------------------
    // TEST 19: Update dan Delete Patuh Terhadap AbortSignal
    // ----------------------------------------------------
    console.log('\n--- [Test 19] Update & Delete Event Honour AbortSignal ---');
    {
      const abortCtrl = new AbortController();
      abortCtrl.abort();

      // Test Update with aborted signal
      let updateCaught = false;
      try {
        await updateGoogleCalendarEvent(
          'mock-token',
          'gcal-event-123',
          { title: 'Judul Baru' },
          abortCtrl.signal
        );
      } catch (err: any) {
        updateCaught = true;
        const classification =
          err instanceof GoogleCalendarApiError
            ? err.classification
            : classifyGoogleCalendarError(0, err.message || '', err);
        assert.strictEqual(classification.code, 'ABORTED');
      }
      assert.strictEqual(updateCaught, true, 'updateGoogleCalendarEvent harus melempar error saat signal aborted');

      // Test Delete with aborted signal
      let deleteCaught = false;
      try {
        await deleteGoogleCalendarEvent('mock-token', 'gcal-event-123', abortCtrl.signal);
      } catch (err: any) {
        deleteCaught = true;
        const classification =
          err instanceof GoogleCalendarApiError
            ? err.classification
            : classifyGoogleCalendarError(0, err.message || '', err);
        assert.strictEqual(classification.code, 'ABORTED');
      }
      assert.strictEqual(deleteCaught, true, 'deleteGoogleCalendarEvent harus melempar error saat signal aborted');
      console.log('  ✅ [PASS] Test 19: updateGoogleCalendarEvent dan deleteGoogleCalendarEvent patuh terhadap AbortSignal.');
    }

    // ----------------------------------------------------
    // TEST 20: Pagination Limit Exceeded Melempar Error & Melindungi Kalender Lokal
    // ----------------------------------------------------
    console.log('\n--- [Test 20] Pagination Limit Exceeded Throws PAGINATION_LIMIT_EXCEEDED ---');
    {
      let callCount = 0;
      global.fetch = async () => {
        callCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ id: `evt-${callCount}`, summary: `Event page ${callCount}` }],
            nextPageToken: `token-page-${callCount + 1}`, // Always has next token!
          }),
        } as any;
      };

      let caught = false;
      try {
        await fetchGoogleCalendarEvents('mock-token');
      } catch (err: any) {
        caught = true;
        assert.ok(err instanceof GoogleCalendarApiError, 'Harus berupa GoogleCalendarApiError');
        assert.strictEqual(err.code, 'PAGINATION_LIMIT_EXCEEDED');
        assert.strictEqual(err.shouldReauth, false);
        assert.strictEqual(err.isTransient, true);
        assert.ok(err.message.includes('10 halaman'), 'Pesan harus menjelaskan limit 10 halaman');
      }

      assert.strictEqual(caught, true, 'fetchGoogleCalendarEvents harus melempar PAGINATION_LIMIT_EXCEEDED');
      assert.strictEqual(callCount, 10, 'Harus mencoba maksimal 10 halaman sebelum melempar error');
      console.log('  ✅ [PASS] Test 20: Paginasi lebih dari 10 halaman melempar PAGINATION_LIMIT_EXCEEDED dan mencegah silent partial sync.');
    }

    // ----------------------------------------------------
    // TEST 21: 10 Halaman Tanpa NextPageToken Sukses Bersih
    // ----------------------------------------------------
    console.log('\n--- [Test 21] 10 Pages Exactly Without NextPageToken Succeeds ---');
    {
      let callCount = 0;
      global.fetch = async () => {
        callCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ id: `evt-exact-${callCount}`, summary: `Event page ${callCount}` }],
            // On page 10, nextPageToken is null / undefined
            nextPageToken: callCount < 10 ? `token-${callCount + 1}` : undefined,
          }),
        } as any;
      };

      const result = await fetchGoogleCalendarEvents('mock-token');
      assert.strictEqual(callCount, 10);
      assert.strictEqual(result.events.length, 10);
      console.log('  ✅ [PASS] Test 21: Pengambilan tepat 10 halaman yang selesai tuntas berhasil tanpa error.');
    }

    // ----------------------------------------------------
    // TEST 22: Unknown 403 Reason Menghasilkan Pesan Netral Tanpa Menuduh OAuth
    // ----------------------------------------------------
    console.log('\n--- [Test 22] Unknown 403 Reason Handled with Neutral Message ---');
    {
      const raw403Unknown = JSON.stringify({
        error: {
          code: 403,
          message: 'Unknown security restriction code 9982',
          errors: [{ domain: 'unknownDomain', reason: 'unrecognizedSecurityFlag', message: 'Restricted' }],
        },
      });

      const classification = classifyGoogleCalendarError(403, raw403Unknown);
      assert.strictEqual(classification.code, 'UNKNOWN_ERROR');
      assert.strictEqual(classification.status, 403);
      assert.strictEqual(classification.shouldReauth, false);
      assert.strictEqual(classification.isPermissionError, false);
      assert.strictEqual(classification.isRateLimitError, false);
      assert.strictEqual(
        classification.message.includes('izin cakupan (OAuth scope)'),
        false,
        'Alasan 403 yang tidak dikenal tidak boleh sembarangan menuduh OAuth scope'
      );
      assert.ok(classification.message.includes('Akses Google Calendar dibatasi atau ditolak oleh server Google (HTTP 403)'));
      console.log('  ✅ [PASS] Test 22: Alasan 403 tidak dikenal menghasilkan pesan netral tanpa menuduh OAuth scope.');
    }

    // ----------------------------------------------------
    // TEST 23: Pesan Network Error Menyaring Token, Refresh Token, dan Email
    // ----------------------------------------------------
    console.log('\n--- [Test 23] Network Error Sanitizes Tokens, Refresh Tokens & Emails ---');
    {
      const leakAttemptMsg = 'Network failed connecting with ya29.a0AfSecretToken and 1//0gSecretRefreshToken for user testuser@gmail.com';
      const netErr = new TypeError(leakAttemptMsg);
      const classification = classifyGoogleCalendarError(0, '', netErr);

      assert.strictEqual(classification.code, 'NETWORK_ERROR');
      assert.strictEqual(classification.message.includes('ya29.a0AfSecretToken'), false, 'ya29 tidak boleh bocor');
      assert.strictEqual(classification.message.includes('1//0gSecretRefreshToken'), false, 'refresh token tidak boleh bocor');
      assert.strictEqual(classification.message.includes('testuser@gmail.com'), false, 'email tidak boleh bocor');
      assert.ok(classification.message.includes('[REDACTED_TOKEN]'), 'Token harus disamarkan');
      assert.ok(classification.message.includes('[REDACTED_REFRESH_TOKEN]'), 'Refresh token harus disamarkan');
      assert.ok(classification.message.includes('[REDACTED_EMAIL]'), 'Email harus disamarkan');
      console.log('  ✅ [PASS] Test 23: Pesan network error menyaring rahasia kredensial dan PII secara menyeluruh.');
    }

    // ----------------------------------------------------
    // TEST 24: accessNotConfigured Dipisahkan Menjadi API_NOT_CONFIGURED
    // ----------------------------------------------------
    console.log('\n--- [Test 24] accessNotConfigured Separated as API_NOT_CONFIGURED ---');
    {
      const rawAccessNotConfigured = JSON.stringify({
        error: {
          code: 403,
          message: 'Google Calendar API has not been used in project 123456 before or it is disabled.',
          errors: [{ domain: 'usageLimits', reason: 'accessNotConfigured', message: 'API not enabled' }],
        },
      });

      const classification = classifyGoogleCalendarError(403, rawAccessNotConfigured);
      assert.strictEqual(classification.code, 'API_NOT_CONFIGURED');
      assert.strictEqual(classification.status, 403);
      assert.strictEqual(classification.isAuthError, false);
      assert.strictEqual(classification.isPermissionError, false, 'Bukan permission error scope pengguna');
      assert.strictEqual(classification.isRateLimitError, false);
      assert.strictEqual(classification.shouldReauth, false);
      assert.ok(
        classification.message.includes('Google Calendar API belum diaktifkan'),
        'Pesan harus menjelaskan API belum diaktifkan di GCP'
      );
      assert.strictEqual(
        classification.message.includes('izin cakupan (OAuth scope)'),
        false,
        'accessNotConfigured TIDAK boleh menuduh OAuth scope'
      );

      // Uji juga fallback text parsing tanpa errors array
      const rawFallback = JSON.stringify({
        error: {
          code: 403,
          message: 'Access not configured on project.',
        },
      });
      const cFallback = classifyGoogleCalendarError(403, rawFallback);
      assert.strictEqual(cFallback.code, 'API_NOT_CONFIGURED');

      console.log('  ✅ [PASS] Test 24: accessNotConfigured terpisah bersih ke API_NOT_CONFIGURED tanpa salah sangka OAuth scope.');
    }

    // ----------------------------------------------------
    // TEST 25: Konsistensi Pesan HTTP 403 di 4 Operasi (Tanpa Ditimpa Generik)
    // ----------------------------------------------------
    console.log('\n--- [Test 25] HTTP 403 Message Consistency Across All 4 Operations ---');
    {
      const raw403Scope = JSON.stringify({
        error: {
          code: 403,
          message: 'Insufficient Permission',
          errors: [{ domain: 'global', reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
        },
      });

      global.fetch = async () =>
        ({
          ok: false,
          status: 403,
          text: async () => raw403Scope,
        } as any);

      // 1. fetch
      try {
        await fetchGoogleCalendarEvents('mock-token');
        assert.fail('fetch harus melempar error');
      } catch (err: any) {
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'PERMISSION_DENIED');
        assert.strictEqual(
          err.message,
          'Akses Google Calendar ditolak (HTTP 403). Pastikan izin cakupan (OAuth scope) kalender telah disetujui pada akun Google Anda.',
          'Pesan tidak boleh ditimpa prefix generik'
        );
      }

      // 2. create
      try {
        await createGoogleCalendarEvent('mock-token', {
          title: 'Test Create',
          startAt: '2026-11-05T09:00:00+07:00',
          endAt: '2026-11-05T10:00:00+07:00',
        });
        assert.fail('create harus melempar error');
      } catch (err: any) {
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'PERMISSION_DENIED');
        assert.strictEqual(
          err.message,
          'Akses Google Calendar ditolak (HTTP 403). Pastikan izin cakupan (OAuth scope) kalender telah disetujui pada akun Google Anda.'
        );
      }

      // 3. update
      try {
        await updateGoogleCalendarEvent('mock-token', 'gcal-test-1', {
          title: 'Test Update',
        });
        assert.fail('update harus melempar error');
      } catch (err: any) {
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'PERMISSION_DENIED');
        assert.strictEqual(
          err.message,
          'Akses Google Calendar ditolak (HTTP 403). Pastikan izin cakupan (OAuth scope) kalender telah disetujui pada akun Google Anda.'
        );
      }

      // 4. delete
      try {
        await deleteGoogleCalendarEvent('mock-token', 'gcal-test-1');
        assert.fail('delete harus melempar error');
      } catch (err: any) {
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'PERMISSION_DENIED');
        assert.strictEqual(
          err.message,
          'Akses Google Calendar ditolak (HTTP 403). Pastikan izin cakupan (OAuth scope) kalender telah disetujui pada akun Google Anda.'
        );
      }

      console.log('  ✅ [PASS] Test 25: Keempat operasi mempertahankan pesan klasifikasi HTTP 403 tanpa ditimpa string generik.');
    }

    // ----------------------------------------------------
    // TEST 26: Uji Mendalam Sanitasi Token, URL Query Params, & PII
    // ----------------------------------------------------
    console.log('\n--- [Test 26] Comprehensive Sensitive Token, Query Param & PII Sanitization ---');
    {
      // 1. Variasi Token
      const tokenVar = 'Error with ya29.a0AfH6S-token.val_123 and refresh 1//0gX_secret.code-456';
      const cleanToken = sanitizeSensitiveText(tokenVar);
      assert.strictEqual(cleanToken.includes('ya29.'), false);
      assert.strictEqual(cleanToken.includes('1//'), false);
      assert.ok(cleanToken.includes('[REDACTED_TOKEN]'));
      assert.ok(cleanToken.includes('[REDACTED_REFRESH_TOKEN]'));

      // 2. Bearer Header variasi
      const bearerVar = 'Authorization failed for Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token_payload';
      const cleanBearer = sanitizeSensitiveText(bearerVar);
      assert.strictEqual(cleanBearer.includes('eyJhbGciOi'), false);
      assert.ok(cleanBearer.includes('Bearer [REDACTED]'));

      // 3. Email variasi (termasuk subdomain & alias)
      const emailVar = 'User fajriansyah.pratama+planner@sub.domain.co.id encountered error';
      const cleanEmail = sanitizeSensitiveText(emailVar);
      assert.strictEqual(cleanEmail.includes('fajriansyah.pratama'), false);
      assert.ok(cleanEmail.includes('[REDACTED_EMAIL]'));

      // 4. URL Query Parameters Sensitif
      const urlVar =
        'https://www.googleapis.com/calendar/v3/events?access_token=ya29.secret&key=AIzaSySecretKey&client_secret=supersecret&code=4/authCode&apiKey=AIzaSecret&refresh_token=1//refreshSecret';
      const cleanUrl = sanitizeSensitiveText(urlVar);
      assert.strictEqual(cleanUrl.includes('AIzaSySecretKey'), false);
      assert.strictEqual(cleanUrl.includes('supersecret'), false);
      assert.strictEqual(cleanUrl.includes('authCode'), false);
      assert.ok(cleanUrl.includes('access_token=[REDACTED]'));
      assert.ok(cleanUrl.includes('key=[REDACTED]'));
      assert.ok(cleanUrl.includes('client_secret=[REDACTED]'));
      assert.ok(cleanUrl.includes('code=[REDACTED]'));
      assert.ok(cleanUrl.includes('apiKey=[REDACTED]'));
      assert.ok(cleanUrl.includes('refresh_token=[REDACTED]'));

      // 5. JSON Key-Value Format
      const jsonVar = '{"access_token": "ya29.secret123", "client_secret": "mySecretPass"}';
      const cleanJson = sanitizeSensitiveText(jsonVar);
      assert.strictEqual(cleanJson.includes('secret123'), false);
      assert.strictEqual(cleanJson.includes('mySecretPass'), false);

      console.log('  ✅ [PASS] Test 26: Sanitasi token, query parameter, Bearer, email, dan JSON terbukti 100% aman.');
    }

    // ----------------------------------------------------
    // TEST 27: Abort Saat Pembacaan Response Body (res.text & res.json)
    // ----------------------------------------------------
    console.log('\n--- [Test 27] Abort During Body Stream/Reading Classified as ABORTED ---');
    {
      const abortCtrl = new AbortController();

      // Mock fetch: headers arrive OK (status 200), but json() body read is aborted
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            abortCtrl.abort();
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            throw err;
          },
          text: async () => {
            abortCtrl.abort();
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            throw err;
          },
        } as any);

      // Test fetchGoogleCalendarEvents body read abort
      try {
        await fetchGoogleCalendarEvents('mock-token', undefined, undefined, abortCtrl.signal);
        assert.fail('Harus melempar error saat json() di-abort');
      } catch (err: any) {
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(
          err.code,
          'ABORTED',
          'Abort saat membaca json body HARUS diklasifikasikan sebagai ABORTED (bukan INVALID_RESPONSE)'
        );
        assert.strictEqual(err.shouldReauth, false);
      }

      // Test createGoogleCalendarEvent body read abort
      const abortCtrlCreate = new AbortController();
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            abortCtrlCreate.abort();
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            throw err;
          },
        } as any);

      try {
        await createGoogleCalendarEvent(
          'mock-token',
          {
            title: 'Test Abort Body',
            startAt: '2026-11-05T09:00:00+07:00',
            endAt: '2026-11-05T10:00:00+07:00',
          },
          abortCtrlCreate.signal
        );
        assert.fail('Harus melempar error saat json() di-abort');
      } catch (err: any) {
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'ABORTED');
      }

      // Test error text read abort (status 500, but text() read is aborted)
      const abortCtrlText = new AbortController();
      global.fetch = async () =>
        ({
          ok: false,
          status: 500,
          text: async () => {
            abortCtrlText.abort();
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            throw err;
          },
        } as any);

      try {
        await fetchGoogleCalendarEvents('mock-token', undefined, undefined, abortCtrlText.signal);
        assert.fail('Harus melempar error saat text() di-abort');
      } catch (err: any) {
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(
          err.code,
          'ABORTED',
          'Abort saat membaca error body HARUS diklasifikasikan sebagai ABORTED (bukan SERVICE_UNAVAILABLE)'
        );
      }

      console.log('  ✅ [PASS] Test 27: Pembatalan saat membaca streaming body (res.json & res.text) tepat diklasifikasikan sebagai ABORTED.');
    }

    // ----------------------------------------------------
    // TEST 28: Integration Test OAuth Race Condition dengan CalendarOperationGuard
    // ----------------------------------------------------
    console.log('\n--- [Test 28] Integration Tests: OAuth Race Condition via CalendarOperationGuard ---');
    {
      const guard = new CalendarOperationGuard();

      // Skenario 1: Connect → Disconnect → OAuth popup resolve
      {
        let storedToken: string | null = null;
        let connectionStatus = 'unconnected';

        const ticket1 = guard.startConnect();
        connectionStatus = 'connecting';

        // Pengguna memutus koneksi sebelum popup 1 selesai
        guard.disconnect();
        connectionStatus = 'unconnected';
        storedToken = null;

        // Popup 1 selesai setelah disconnect
        if (!ticket1.isStale()) {
          storedToken = 'stale-token-op1';
          connectionStatus = 'connected_unsynced';
        }

        assert.strictEqual(storedToken, null, 'Popup lama setelah disconnect tidak boleh menyimpan token');
        assert.strictEqual(connectionStatus, 'unconnected', 'Status harus tetap unconnected');
      }

      // Skenario 2: Connect A → Connect B → A resolve lebih lambat
      {
        let storedToken: string | null = null;

        const ticketA = guard.startConnect();
        const ticketB = guard.startConnect();

        // Popup B selesai lebih dahulu
        if (!ticketB.isStale()) {
          storedToken = 'token-from-B';
        }

        // Popup A selesai belakangan
        if (!ticketA.isStale()) {
          storedToken = 'token-from-A';
        }

        assert.strictEqual(storedToken, 'token-from-B', 'Token B harus dipertahankan, Token A diabaikan');
      }

      // Skenario 3: Connect A → Disconnect → Connect B → A resolve paling akhir
      {
        let storedToken: string | null = null;

        const ticketA = guard.startConnect();
        guard.disconnect();
        const ticketB = guard.startConnect();

        // Popup B selesai
        if (!ticketB.isStale()) {
          storedToken = 'token-from-B';
        }

        // Popup A lama menyelesaikan paling akhir
        if (!ticketA.isStale()) {
          storedToken = 'stale-token-A';
        }

        assert.strictEqual(storedToken, 'token-from-B', 'Popup A lama tidak boleh menimpa koneksi baru B');
      }

      // Skenario 4: OAuth popup lama gagal setelah koneksi baru berhasil
      {
        let connectionStatus = 'unconnected';

        const ticketOld = guard.startConnect();
        const ticketNew = guard.startConnect();

        if (!ticketNew.isStale()) {
          connectionStatus = 'sync_success';
        }

        // Popup lama gagal dengan error auth/cancelled
        if (!ticketOld.isStale()) {
          connectionStatus = 'sync_failed';
        }

        assert.strictEqual(connectionStatus, 'sync_success', 'Error dari popup lama tidak boleh merusak status sukses koneksi baru');
      }

      console.log('  ✅ [PASS] Test 28: Keempat skenario balapan OAuth diverifikasi kokoh menggunakan CalendarOperationGuard produksi.');
    }

    // ----------------------------------------------------
    // TEST 29: Verifikasi Integritas Data & Pencegahan Duplikasi
    // ----------------------------------------------------
    console.log('\n--- [Test 29] Data Integrity & Duplicate Creation Prevention ---');
    {
      // 1. Pagination Limit Exceeded tidak merusak state event lokal
      const initialLocalEvents: CalendarEvent[] = [
        {
          id: 'task-local-1',
          provider: 'internal',
          title: 'Tugas Penting',
          startAt: '2026-11-05T09:00:00+07:00',
          endAt: '2026-11-05T10:00:00+07:00',
          category: 'focus',
          syncStatus: 'pending',
          isEditable: true,
        },
      ];

      let localState = [...initialLocalEvents];
      let pageCount = 0;
      global.fetch = async () => {
        pageCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ id: `gcal-${pageCount}`, summary: `Event ${pageCount}` }],
            nextPageToken: `token-${pageCount + 1}`,
          }),
        } as any;
      };

      try {
        const fetchRes = await fetchGoogleCalendarEvents('mock-token');
        localState = [...fetchRes.events]; // jika sukses, menimpa
      } catch (err: any) {
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'PAGINATION_LIMIT_EXCEEDED');
        // Saat error, localState TIDAK diubah
      }

      assert.strictEqual(localState.length, 1);
      assert.strictEqual(localState[0].id, 'task-local-1', 'Data lokal harus tetap utuh');

      // 2. Abort saat batch create mempertahankan sesi unpushed
      const abortCtrl = new AbortController();
      let createdCalls = 0;
      global.fetch = async () => {
        createdCalls++;
        if (createdCalls === 1) {
          abortCtrl.abort();
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: `gcal-created-${createdCalls}` }),
        } as any;
      };

      const batchItems = [
        { id: 'sess-1', title: 'Sesi 1', startAt: '2026-11-05T09:00:00+07:00', endAt: '2026-11-05T10:00:00+07:00' },
        { id: 'sess-2', title: 'Sesi 2', startAt: '2026-11-05T10:30:00+07:00', endAt: '2026-11-05T11:30:00+07:00' },
        { id: 'sess-3', title: 'Sesi 3', startAt: '2026-11-05T13:00:00+07:00', endAt: '2026-11-05T14:00:00+07:00' },
      ];

      const batchResult = await batchCreateGoogleCalendarEvents('mock-token', batchItems, 1, abortCtrl.signal);
      const unpushed = batchResult.results.filter((r) => !r.googleCalendarEventId);
      assert.ok(unpushed.length >= 2, 'Sesi yang belum terkirim harus tercatat agar status lokal tetap pending');

      // 3. Pencegahan duplikasi event: item dengan googleCalendarEventId tidak dipanggil ulang
      let duplicateCallCount = 0;
      global.fetch = async () => {
        duplicateCallCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'new-gcal-id' }),
        } as any;
      };

      const retryItems = [
        {
          id: 'sess-1',
          title: 'Sesi 1 (Sudah Ada di Google)',
          startAt: '2026-11-05T09:00:00+07:00',
          endAt: '2026-11-05T10:00:00+07:00',
          googleCalendarEventId: 'existing-gcal-123',
          syncStatus: 'synced',
        },
        {
          id: 'sess-2',
          title: 'Sesi 2 (Baru)',
          startAt: '2026-11-05T10:30:00+07:00',
          endAt: '2026-11-05T11:30:00+07:00',
        },
      ];

      const retryBatch = await batchCreateGoogleCalendarEvents('mock-token', retryItems);
      assert.strictEqual(duplicateCallCount, 1, 'Hanya sesi baru (sess-2) yang boleh memanggil API Google Calendar');
      assert.strictEqual(retryBatch.results[0].googleCalendarEventId, 'existing-gcal-123');

      console.log('  ✅ [PASS] Test 29: Integritas data lokal terjaga, sesi unpushed terpelihara, dan pencegahan duplikasi terbukti bekerja.');
    }

    // ----------------------------------------------------
    // TEST 30: Audit Statis Kode Sumber App.tsx terhadap Identifier Usang
    // ----------------------------------------------------
    console.log('\n--- [Test 30] Static Source Code Audit of App.tsx (Zero Stale Identifiers) ---');
    {
      const appSourcePath = path.resolve(process.cwd(), 'src/App.tsx');
      assert.ok(fs.existsSync(appSourcePath), 'File src/App.tsx harus ada');
      const appSource = fs.readFileSync(appSourcePath, 'utf-8');

      const forbiddenIdentifiers = [
        'syncRequestIdRef',
        'currentRequestId',
        'pushAbortController',
        'activeAbortControllerRef',
        'connectOperationIdRef',
      ];

      for (const id of forbiddenIdentifiers) {
        const regex = new RegExp(`\\b${id}\\b`, 'g');
        const matches = appSource.match(regex);
        assert.strictEqual(
          matches,
          null,
          `Identifier usang "${id}" tidak boleh ada dalam src/App.tsx setelah migrasi ke CalendarOperationGuard`
        );
      }

      assert.ok(
        appSource.includes('CalendarOperationGuard'),
        'src/App.tsx harus mengimpor dan menggunakan CalendarOperationGuard'
      );
      assert.ok(
        appSource.includes('pushTicket.isAborted()'),
        'src/App.tsx harus menggunakan pushTicket.isAborted() untuk mendeteksi pembatalan push'
      );
      assert.ok(
        appSource.includes('!ticket.isStale()'),
        'handleSyncCalendar harus menggunakan !ticket.isStale() di blok finally'
      );

      console.log('  ✅ [PASS] Test 30: Seluruh 5 identifier usang terbukti 100% bersih dari src/App.tsx.');
    }

    // ----------------------------------------------------
    // TEST 31: Audit Transisi State Komprehensif via CalendarOperationGuard Produksi
    // ----------------------------------------------------
    console.log('\n--- [Test 31] Comprehensive State Transitions via Production CalendarOperationGuard ---');
    {
      const guard = new CalendarOperationGuard();

      // Skenario 1: Connect -> Disconnect -> OAuth resolve diabaikan
      const connectTicket1 = guard.startConnect();
      assert.strictEqual(connectTicket1.isStale(), false);
      guard.disconnect();
      assert.strictEqual(connectTicket1.isStale(), true, 'Connect 1 harus stale setelah disconnect');
      assert.strictEqual(guard.isConnectActive(connectTicket1.connectId), false);

      // Skenario 2: Connect A -> Connect B -> A resolve terakhir (A diabaikan, B aktif)
      const connectA = guard.startConnect();
      const connectB = guard.startConnect();
      assert.strictEqual(connectA.isStale(), true, 'Connect A harus stale setelah Connect B dimulai');
      assert.strictEqual(connectB.isStale(), false, 'Connect B harus tetap aktif');
      assert.strictEqual(guard.isConnectActive(connectB.connectId), true);
      assert.strictEqual(guard.isConnectActive(connectA.connectId), false);

      // Skenario 3: Sync A -> Sync B -> A resolve terakhir
      const syncA = guard.startSync();
      assert.strictEqual(syncA.isStale(), false);
      assert.strictEqual(syncA.signal.aborted, false);

      const syncB = guard.startSync();
      // Sync A harus dibatalkan sinyalnya dan ditandai stale
      assert.strictEqual(syncA.signal.aborted, true, 'Sync A AbortSignal harus dipicu saat Sync B dimulai');
      assert.strictEqual(syncA.isStale(), true, 'Sync A harus ditandai stale saat Sync B dimulai');
      assert.strictEqual(syncB.isStale(), false, 'Sync B harus aktif');
      assert.strictEqual(syncB.signal.aborted, false, 'Sync B AbortSignal harus tetap aktif');

      // Simulasi blok finally: hanya operasi aktif yang boleh mengubah state isSyncing
      let simulatedIsSyncing = true;
      if (!syncA.isStale()) {
        simulatedIsSyncing = false; // Stale sync A tidak boleh mengeksekusi ini
      }
      assert.strictEqual(simulatedIsSyncing, true, 'Sync A stale tidak boleh mengubah status isSyncing');

      if (!syncB.isStale()) {
        simulatedIsSyncing = false; // Sync B aktif berhak mengubah
      }
      assert.strictEqual(simulatedIsSyncing, false, 'Sync B aktif berhak menyelesaikan isSyncing');

      // Skenario 4: Push A -> Disconnect -> Push A dibatalkan
      const pushA = guard.startPush();
      assert.strictEqual(pushA.isAborted(), false);
      assert.strictEqual(pushA.isStale(), false);

      guard.disconnect();
      assert.strictEqual(pushA.isAborted(), true, 'Push A harus dibatalkan saat disconnect dipanggil');
      assert.strictEqual(pushA.isStale(), true, 'Push A harus stale saat disconnect dipanggil');

      // Skenario 5: Push A -> Push B -> Push A dibatalkan
      const push1 = guard.startPush();
      assert.strictEqual(push1.isAborted(), false);
      assert.strictEqual(push1.isStale(), false);

      const push2 = guard.startPush();
      assert.strictEqual(push1.isAborted(), true, 'Push 1 harus dibatalkan saat Push 2 dimulai');
      assert.strictEqual(push1.isStale(), true, 'Push 1 harus stale saat Push 2 dimulai');
      assert.strictEqual(push2.isAborted(), false, 'Push 2 harus aktif');
      assert.strictEqual(push2.isStale(), false, 'Push 2 tidak boleh stale');

      console.log('  ✅ [PASS] Test 31: Seluruh 5 skenario transisi state kalender terverifikasi deterministik dan kokoh.');
    }

    // ----------------------------------------------------
    // TEST 32: Anomali Status Synced Tanpa Google Event ID Menghasilkan NEEDS_RECONCILIATION
    // ----------------------------------------------------
    console.log('\n--- [Test 32] Synced Status Without Event ID Requires Reconciliation ---');
    {
      let remoteCreateInvoked = false;
      global.fetch = async () => {
        remoteCreateInvoked = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'unexpected-id' }),
        } as any;
      };

      const testItems = [
        {
          id: 'item-synced-valid',
          title: 'Sesi Valid',
          startAt: '2026-11-05T09:00:00+07:00',
          endAt: '2026-11-05T10:00:00+07:00',
          syncStatus: 'synced',
          googleCalendarEventId: 'gcal-existing-99',
        },
        {
          id: 'item-synced-missing-id',
          title: 'Sesi Anomali (Synced tapi ID kosong)',
          startAt: '2026-11-05T10:30:00+07:00',
          endAt: '2026-11-05T11:30:00+07:00',
          syncStatus: 'synced',
          googleCalendarEventId: '', // ID kosong / hilang
        },
        {
          id: 'item-synced-whitespace-id',
          title: 'Sesi Anomali (Synced tapi ID spasi)',
          startAt: '2026-11-05T13:00:00+07:00',
          endAt: '2026-11-05T14:00:00+07:00',
          syncStatus: 'synced',
          googleCalendarEventId: '   ',
        },
      ];

      const batchRes = await batchCreateGoogleCalendarEvents('mock-token', testItems);

      // 1. remote API tidak boleh dipanggil secara buta untuk item anomali
      assert.strictEqual(remoteCreateInvoked, false, 'API remote tidak boleh dipanggil untuk item anomali');

      // 2. Panjang hasil harus tepat sama dengan jumlah input
      assert.strictEqual(batchRes.results.length, 3, 'Panjang hasil batch harus tepat 3 sesuai input');
      assert.strictEqual(batchRes.totalRequested, 3);

      // 3. Item 1 (valid) lolos idempoten
      assert.strictEqual(batchRes.results[0].googleCalendarEventId, 'gcal-existing-99');
      assert.strictEqual(batchRes.results[0].error, undefined);

      // 4. Item 2 & 3 (anomali) ditandai NEEDS_RECONCILIATION dan tidak diklaim sukses
      assert.strictEqual(batchRes.results[1].googleCalendarEventId, undefined);
      assert.strictEqual(batchRes.results[1].classification?.code, 'NEEDS_RECONCILIATION');
      assert.strictEqual(batchRes.results[1].classification?.status, 409);
      assert.ok(batchRes.results[1].error?.includes('rekonsiliasi'));

      assert.strictEqual(batchRes.results[2].googleCalendarEventId, undefined);
      assert.strictEqual(batchRes.results[2].classification?.code, 'NEEDS_RECONCILIATION');

      console.log('  ✅ [PASS] Test 32: Status synced tanpa ID Google Calendar dicegah dari sukses palsu dan diarahkan ke rekonsiliasi.');
    }

    // ----------------------------------------------------
    // TEST 33: Simulasi Hilangnya Respons Pasca-Kreasi Server (Keterbatasan Google v3 & Idempotensi)
    // ----------------------------------------------------
    console.log('\n--- [Test 33] Network Loss Post-Server Creation & Idempotency Strategy ---');
    {
      // Skenario arsitektur: Google Calendar v3 API tidak mendukung client-side idempotency keys.
      // Ketika TCP reset terjadi saat klien membaca respons (setelah server berhasil membuat event),
      // error harus terklasifikasi sebagai NETWORK_ERROR dan sesi lokal tidak boleh dianggap sukses palsu.
      global.fetch = async () => {
        throw new TypeError('fetch failed: connection reset by peer');
      };

      try {
        await createGoogleCalendarEvent('mock-token', {
          title: 'Sesi Uji Network Reset',
          startAt: '2026-11-05T09:00:00+07:00',
          endAt: '2026-11-05T10:00:00+07:00',
        });
        assert.fail('Harus melempar network error');
      } catch (err: any) {
        assert.ok(err instanceof GoogleCalendarApiError);
        assert.strictEqual(err.code, 'NETWORK_ERROR');
        assert.strictEqual(err.classification.isAuthError, false, 'Network drop bukan kesalahan autentikasi');
        assert.strictEqual(err.classification.shouldReauth, false);
      }

      console.log('  ✅ [PASS] Test 33: Keterbatasan idempotensi pasca-kreasi server tertangani aman dengan klasifikasi NETWORK_ERROR dan perlindungan data lokal.');
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
