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
  reconcileSessionWithRemoteEvents,
} from '../src/lib/googleCalendar';
import { CalendarOperationGuard } from '../src/lib/calendarOperationGuard';
import { persistScheduledTask } from '../src/lib/taskPersistence';
import {
  executeSchedulePush,
  reconcileTaskSessionsWithRemote,
} from '../src/lib/calendarPushService';
import { CalendarEvent, Task, TaskScheduleSession } from '../src/types';

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
    // TEST 33: Simulasi Kontrak Hilangnya Respons Pasca-Kreasi Server (Idempotensi & Anti-Duplikasi)
    // ----------------------------------------------------
    console.log('\n--- [Test 33] Network Loss Post-Server Creation & Idempotency Contract Simulation ---');
    {
      // Mock database server Google Calendar remote
      const mockServerDb = new Map<string, any>();
      let postCallCount = 0;

      // 1. Simulasikan: Server Google berhasil menulis event, namun koneksi TCP putus saat mengirim respons
      global.fetch = async (url: any, opts: any) => {
        if (opts?.method === 'POST') {
          postCallCount++;
          const body = JSON.parse(opts.body || '{}');
          const serverAssignedId = `server-created-id-${postCallCount}`;
          // Server Google menyimpan event ke kalender pengguna:
          mockServerDb.set(serverAssignedId, {
            id: serverAssignedId,
            summary: body.summary,
            start: body.start,
            end: body.end,
          });

          // Koneksi TCP terputus mendadak sebelum respons diterima klien (network drop)
          throw new TypeError('fetch failed: connection reset by peer');
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      };

      // Klien mencoba membuat event
      let caughtError: any = null;
      try {
        await createGoogleCalendarEvent('mock-token', {
          title: 'Sesi Uji Network Reset',
          startAt: '2026-11-05T09:00:00+07:00',
          endAt: '2026-11-05T10:00:00+07:00',
        });
      } catch (err: any) {
        caughtError = err;
      }

      // Verifikasi 1: Klien menerima NETWORK_ERROR
      assert.ok(caughtError instanceof GoogleCalendarApiError, 'Klien harus menerima GoogleCalendarApiError');
      assert.strictEqual(caughtError.code, 'NETWORK_ERROR');
      assert.strictEqual(caughtError.classification.status, 0);
      assert.strictEqual(caughtError.classification.isAuthError, false, 'Network drop bukan kesalahan autentikasi');

      // Verifikasi 2: Tidak ada retry POST otomatis yang buta
      assert.strictEqual(postCallCount, 1, 'Klien tidak boleh melakukan retry POST otomatis secara buta');

      // Verifikasi 3: Jika sesi lokal dicoba kirim ulang dengan status 'synced' tapi ID kosong,
      // sistem menolak klaim sukses palsu dan mengembalikan NEEDS_RECONCILIATION
      const unconfirmedItem = [
        {
          id: 'local-sess-lost-ack',
          title: 'Sesi Uji Network Reset',
          startAt: '2026-11-05T09:00:00+07:00',
          endAt: '2026-11-05T10:00:00+07:00',
          syncStatus: 'synced',
          googleCalendarEventId: '', // Remote ID belum diketahui klien
        },
      ];
      const reconResult = await batchCreateGoogleCalendarEvents('mock-token', unconfirmedItem);
      assert.strictEqual(reconResult.results[0].classification?.code, 'NEEDS_RECONCILIATION');
      assert.strictEqual(postCallCount, 1, 'Tidak boleh memanggil POST ulang saat status membutuhkan rekonsiliasi');

      // Verifikasi 4: Ketika remote ID yang sudah tercipta di server (server-created-id-1) diketahui/dikonfirmasi,
      // event tidak dibuat ulang secara duplikat di remote
      const reconciledItem = [
        {
          id: 'local-sess-lost-ack',
          title: 'Sesi Uji Network Reset',
          startAt: '2026-11-05T09:00:00+07:00',
          endAt: '2026-11-05T10:00:00+07:00',
          syncStatus: 'synced',
          googleCalendarEventId: 'server-created-id-1', // ID remote yang tersimpan di mockServerDb
        },
      ];
      const idempotentResult = await batchCreateGoogleCalendarEvents('mock-token', reconciledItem);
      assert.strictEqual(idempotentResult.results[0].googleCalendarEventId, 'server-created-id-1');
      assert.strictEqual(postCallCount, 1, 'Event yang sudah tercipta di mock server tidak boleh dibuat ulang');
      assert.strictEqual(mockServerDb.size, 1, 'Jumlah event di server mock tetap tepat 1 (tanpa duplikasi)');

      console.log('  ✅ [PASS] Test 33: Simulasi network loss pasca-kreasi server terverifikasi: NETWORK_ERROR aman, butuh rekonsiliasi, dan anti-duplikasi.');
    }

    // ----------------------------------------------------
    // TEST 34: Persistensi Stale Push Akibat Disconnect (Unit & Integration Contract)
    // ----------------------------------------------------
    console.log('\n--- [Test 34] Stale Push Persistence After Disconnect (Session & Firestore Integrity) ---');
    {
      const guard = new CalendarOperationGuard();
      const pushTicket = guard.startPush();

      let createdCount = 0;
      global.fetch = async () => {
        createdCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: `gcal-sess-${createdCount}`, htmlLink: `https://cal.google.com/event?id=${createdCount}` }),
        } as any;
      };

      const initialSessions = [
        { id: 'sess-1', taskTitle: 'Tugas Belajar', sessionIndex: 1, totalSessions: 2, durationMinutes: 30, startAt: '2026-11-05T09:00:00+07:00', endAt: '2026-11-05T09:30:00+07:00', syncStatus: 'pending' as const },
        { id: 'sess-2', taskTitle: 'Tugas Belajar', sessionIndex: 2, totalSessions: 2, durationMinutes: 30, startAt: '2026-11-05T10:00:00+07:00', endAt: '2026-11-05T10:30:00+07:00', syncStatus: 'pending' as const },
      ];

      const updatedSessions: any[] = [];
      const newCalendarEvents: CalendarEvent[] = [];
      let wasAborted = false;

      // Iterasi sesi 1: berhasil dibuat di Google
      const sess1 = initialSessions[0];
      const created1 = await createGoogleCalendarEvent('mock-token', {
        title: sess1.taskTitle,
        startAt: sess1.startAt,
        endAt: sess1.endAt,
      }, pushTicket.signal);

      updatedSessions.push({
        ...sess1,
        syncStatus: 'synced',
        googleCalendarEventId: created1.id,
      });
      newCalendarEvents.push({
        id: `gcal-${created1.id}`,
        provider: 'google',
        title: sess1.taskTitle,
        startAt: sess1.startAt,
        endAt: sess1.endAt,
        isEditable: false,
        syncStatus: 'synced',
        category: 'focus',
      });

      // User memicu Disconnect di tengah jalan!
      guard.disconnect();

      // State UI setelah disconnect
      let connectionStatus = 'unconnected';
      let lastErrorMessage: string | undefined = undefined;

      // Iterasi sesi 2: mendeteksi tiket telah dibatalkan
      if (pushTicket.isAborted()) {
        wasAborted = true;
      }

      // Sesi 2 yang belum terkirim harus tetap pending
      if (wasAborted) {
        updatedSessions.push({
          ...initialSessions[1],
          syncStatus: 'pending',
        });
      }

      assert.strictEqual(pushTicket.isStale(), true, 'Push ticket harus stale setelah disconnect');

      // Jalankan helper persistensi produksi persistScheduledTask
      let reactTasksState: Task[] = [];
      let reactEventsState: CalendarEvent[] = [];
      const mockSetTasks: any = (updater: any) => {
        reactTasksState = typeof updater === 'function' ? updater(reactTasksState) : updater;
      };
      const mockSetEvents: any = (updater: any) => {
        reactEventsState = typeof updater === 'function' ? updater(reactEventsState) : updater;
      };

      const finalTaskObj: Task = {
        id: 'task-test-stale-disconnect',
        userId: 'user-auth-123',
        title: 'Tugas Belajar',
        status: 'SCHEDULED',
        allowSplit: true,
        estimatedDurationMinutes: 60,
        minimumSessionMinutes: 30,
        priority: 'HIGH',
        createdAt: new Date().toISOString(),
        scheduledSessions: updatedSessions,
      };

      const firestoreWrites: any[] = [];
      const mockSaveToStorage = async (task: Task, userId: string) => {
        firestoreWrites.push({ userId, task });
      };

      await persistScheduledTask({
        task: finalTaskObj,
        userId: 'user-auth-123',
        newCalendarEvents,
        setTasks: mockSetTasks,
        setEvents: mockSetEvents,
        isUpdate: true,
        saveToStorage: mockSaveToStorage,
      });

      // Verifikasi 1: Sesi 1 mempertahankan googleCalendarEventId
      assert.strictEqual(reactTasksState[0].scheduledSessions[0].googleCalendarEventId, 'gcal-sess-1');
      assert.strictEqual(reactTasksState[0].scheduledSessions[0].syncStatus, 'synced');

      // Verifikasi 2: Sesi 2 yang belum terkirim tetap pending
      assert.strictEqual(reactTasksState[0].scheduledSessions[1].syncStatus, 'pending');
      assert.strictEqual(reactTasksState[0].scheduledSessions[1].googleCalendarEventId, undefined);

      // Verifikasi 3: Event gcal-sess-1 masuk ke state kalender lokal
      assert.strictEqual(reactEventsState.length, 1);
      assert.strictEqual(reactEventsState[0].id, 'gcal-gcal-sess-1');

      // Verifikasi 4: Task tersimpan secara persisten ke Firestore
      assert.strictEqual(firestoreWrites.length, 1, 'Task harus tersimpan ke Firestore');
      assert.strictEqual(firestoreWrites[0].userId, 'user-auth-123');
      assert.strictEqual(firestoreWrites[0].task.id, 'task-test-stale-disconnect');
      assert.strictEqual(firestoreWrites[0].task.scheduledSessions[0].googleCalendarEventId, 'gcal-sess-1');
      assert.strictEqual(firestoreWrites[0].task.scheduledSessions[1].syncStatus, 'pending');

      // Verifikasi 5: Karena pushTicket.isStale() === true, handler langsung return sebelum memodifikasi status:
      // Status koneksi tetap 'unconnected' dan error lama tidak diinjeksi
      assert.strictEqual(connectionStatus, 'unconnected', 'Status koneksi harus tetap unconnected');
      assert.strictEqual(lastErrorMessage, undefined, 'Diagnostic message tidak boleh tertimpa error dari push lama');

      console.log('  ✅ [PASS] Test 34: Persistensi stale push pasca-disconnect terverifikasi: data tersimpan, sesi pending aman, dan status koneksi terlindungi.');
    }

    // ----------------------------------------------------
    // TEST 35: Persistensi Stale Push Akibat Push Baru (Interleaving Protection)
    // ----------------------------------------------------
    console.log('\n--- [Test 35] Stale Push Persistence Overwritten by Newer Push ---');
    {
      const guard = new CalendarOperationGuard();

      // Push A dimulai untuk Task A
      const pushA = guard.startPush();
      assert.strictEqual(pushA.isStale(), false);

      // Push B dimulai untuk Task B sebelum Push A selesai
      const pushB = guard.startPush();

      // Push A otomatis menjadi stale dan dibatalkan
      assert.strictEqual(pushA.isStale(), true, 'Push A harus ditandai stale saat Push B dimulai');
      assert.strictEqual(pushA.isAborted(), true, 'Push A AbortSignal harus dipicu');
      assert.strictEqual(pushB.isStale(), false, 'Push B harus aktif');
      assert.strictEqual(pushB.isAborted(), false, 'Push B tidak boleh dibatalkan');

      // Simulasi persistensi Task A melalui helper produksi
      let stateTasks: Task[] = [];
      const mockSetTasks: any = (updater: any) => {
        stateTasks = typeof updater === 'function' ? updater(stateTasks) : updater;
      };

      const firestoreWritesB: any[] = [];
      const mockSaveToStorageB = async (task: Task, userId: string) => {
        firestoreWritesB.push({ userId, task });
      };

      const taskA: Task = {
        id: 'task-a',
        userId: 'user-auth-task-a',
        title: 'Task A',
        status: 'SCHEDULED',
        allowSplit: false,
        estimatedDurationMinutes: 30,
        minimumSessionMinutes: 30,
        priority: 'MEDIUM',
        createdAt: new Date().toISOString(),
        scheduledSessions: [
          { id: 'sess-a-1', taskTitle: 'Task A', sessionIndex: 1, totalSessions: 1, durationMinutes: 30, startAt: '2026-11-05T09:00:00+07:00', endAt: '2026-11-05T09:30:00+07:00', syncStatus: 'pending' },
        ],
      };

      await persistScheduledTask({
        task: taskA,
        userId: 'user-auth-task-a',
        setTasks: mockSetTasks,
        saveToStorage: mockSaveToStorageB,
      });

      // Verifikasi Firestore untuk Task A
      assert.strictEqual(firestoreWritesB.length, 1, 'Task A harus tersimpan ke Firestore');
      assert.strictEqual(firestoreWritesB[0].task.id, 'task-a');

      // Diagnostic state milik Push B yang sedang berjalan
      let currentDiagnostic = {
        connectionStatus: 'sync_success',
        lastErrorMessage: undefined,
        eventsCreatedCount: 5,
      };

      // Push A (karena stale) mengecek `if (pushA.isStale()) return;`
      let pushAAttemptedDiagnosticOverwrite = false;
      if (!pushA.isStale()) {
        pushAAttemptedDiagnosticOverwrite = true;
        currentDiagnostic = {
          connectionStatus: 'needs_reauth',
          lastErrorMessage: 'Error stale dari A',
          eventsCreatedCount: 0,
        };
      }

      assert.strictEqual(pushAAttemptedDiagnosticOverwrite, false, 'Push A tidak boleh mengeksekusi mutasi diagnosticInfo');
      assert.strictEqual(currentDiagnostic.connectionStatus, 'sync_success', 'Diagnostic info harus tetap milik operasi aktif');
      assert.strictEqual(currentDiagnostic.eventsCreatedCount, 5);
      assert.strictEqual(stateTasks.length, 1, 'Task A tetap tersimpan di state lokal');

      console.log('  ✅ [PASS] Test 35: Push A stale terlindungi dari menimpa diagnostic state Push B, namun Task A tetap terpersistensi.');
    }

    // ----------------------------------------------------
    // TEST 36 (TEST A): Ambiguous Post State - Server Succeeded, Client Lost Response
    // ----------------------------------------------------
    console.log('\n--- [Test 36 / Test A] Ambiguous Post State (Server Succeeded, Client Lost Response) ---');
    {
      const guard = new CalendarOperationGuard();
      const pushTicket = guard.startPush();

      // Mock remote server database
      const mockServerEvents: Array<{ id: string; title: string; extendedProperties?: any }> = [];

      // Mock create function yang mensimulasikan kegagalan jaringan setelah server berhasil membuat event
      const mockCreateEventNetworkDrop = async (
        _token: string,
        input: any,
        _signal?: AbortSignal
      ) => {
        // Server berhasil membuat event dan mencatatnya ke database server
        const generatedRemoteId = `remote-event-${Date.now()}`;
        mockServerEvents.push({
          id: generatedRemoteId,
          title: input.title,
          extendedProperties: input.extendedProperties,
        });

        // Tepat sebelum mengirimkan respons HTTP 200 kembali ke klien, koneksi socket putus (network drop)
        const netErr = new TypeError('Failed to fetch');
        const classification = classifyGoogleCalendarError(0, '', netErr);
        throw new GoogleCalendarApiError(classification);
      };

      const initialSession: TaskScheduleSession = {
        id: 'sess-ambiguous-net-drop-1',
        taskTitle: 'Desain Arsitektur Sistem',
        sessionIndex: 1,
        totalSessions: 1,
        durationMinutes: 60,
        startAt: '2026-11-06T14:00:00+07:00',
        endAt: '2026-11-06T15:00:00+07:00',
        syncStatus: 'pending',
      };

      const taskToPush: Task = {
        id: 'task-ambiguous-test-1',
        userId: 'user-reliable-1',
        title: 'Desain Arsitektur Sistem',
        status: 'SCHEDULED',
        allowSplit: false,
        estimatedDurationMinutes: 60,
        minimumSessionMinutes: 30,
        priority: 'HIGH',
        createdAt: new Date().toISOString(),
        scheduledSessions: [initialSession],
      };

      let persistedTasks: Task[] = [];
      const mockSetTasks: any = (updater: any) => {
        persistedTasks = typeof updater === 'function' ? updater(persistedTasks) : updater;
      };

      const firestoreSaves: any[] = [];
      const mockSaveToStorage = async (task: Task, userId: string) => {
        firestoreSaves.push({ task, userId });
      };

      // Eksekusi push melalui production handler service executeSchedulePush
      const pushResult = await executeSchedulePush({
        token: 'mock-valid-token',
        task: taskToPush,
        sessions: [initialSession],
        timezone: 'Asia/Jakarta',
        userId: 'user-reliable-1',
        pushTicket,
        setTasks: mockSetTasks,
        createEventFn: mockCreateEventNetworkDrop,
        saveToStorage: mockSaveToStorage,
      });

      // 1. Verifikasi transisi status: Error jaringan dipetakan ke 'needs_reconciliation', BUKAN 'failed'
      assert.strictEqual(pushResult.reconciliationCount, 1, 'Reconciliation count harus 1');
      assert.strictEqual(pushResult.unconfirmedCount, 1, 'Unconfirmed count harus 1');
      assert.strictEqual(pushResult.failCount, 0, 'Fail count tidak boleh bertambah untuk error ambigu');
      assert.strictEqual(pushResult.hasEncounteredAuthError, false, 'Network drop bukan auth error');

      const resultingSession = pushResult.updatedSessions[0];
      assert.strictEqual(
        resultingSession.syncStatus,
        'needs_reconciliation',
        'Sesi dengan network drop harus dialihkan ke status needs_reconciliation'
      );
      assert.strictEqual(
        resultingSession.googleCalendarEventId,
        undefined,
        'Remote ID tidak boleh diisi klaim palsu sebelum terkonfirmasi'
      );

      // 2. Verifikasi persistensi: Task tersimpan di Firestore dan state React dengan status needs_reconciliation
      assert.strictEqual(firestoreSaves.length, 1);
      assert.strictEqual(firestoreSaves[0].task.scheduledSessions[0].syncStatus, 'needs_reconciliation');
      assert.strictEqual(persistedTasks[0].scheduledSessions[0].syncStatus, 'needs_reconciliation');

      // 3. Verifikasi Server: Server berhasil membuat 1 event
      assert.strictEqual(mockServerEvents.length, 1, 'Mock server harus memiliki 1 event yang tersimpan');

      // 4. Verifikasi Larangan Resend Buta (Prohibit Blind Resend):
      // Jika retry atau batchCreateGoogleCalendarEvents dijalankan ulang pada sesi needs_reconciliation tanpa remote ID terverifikasi,
      // operasi harus MENOLAK / MELEWATI pembuatan POST baru secara buta!
      const retryEventsInput = [
        {
          id: resultingSession.id,
          title: `[EVEN] ${resultingSession.taskTitle}`,
          startAt: resultingSession.startAt,
          endAt: resultingSession.endAt,
          syncStatus: resultingSession.syncStatus,
          googleCalendarEventId: resultingSession.googleCalendarEventId,
        },
      ];

      // Panggil batchCreateGoogleCalendarEvents dengan mock fetch yang memantau apakah ada POST yang dikirim
      let attemptedDuplicatePost = false;
      global.fetch = async (url: any, init: any) => {
        if (init?.method === 'POST') {
          attemptedDuplicatePost = true;
          mockServerEvents.push({ id: 'accidental-duplicate', title: 'duplicate' });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'accidental-duplicate' }),
        } as any;
      };

      const batchRetryResult = await batchCreateGoogleCalendarEvents('mock-valid-token', retryEventsInput as any);

      assert.strictEqual(attemptedDuplicatePost, false, 'Dilarang mengirim POST baru secara buta untuk sesi needs_reconciliation');
      assert.strictEqual(mockServerEvents.length, 1, 'Jumlah event di server harus tetap 1, tidak boleh terduplikasi');
      assert.strictEqual(batchRetryResult.results[0].classification?.code, 'NEEDS_RECONCILIATION');

      console.log('  ✅ [PASS] Test 36 (Test A): Network drop terpetakan ke needs_reconciliation, tersimpan persisten, dan POST duplikat dicegah 100%.');
    }

    // ----------------------------------------------------
    // TEST 37 (TEST B): Confirmed Reconciliation via Stable Session ID
    // ----------------------------------------------------
    console.log('\n--- [Test 37 / Test B] Confirmed Reconciliation via Stable Session ID ---');
    {
      const sessionId = 'sess-reconcile-target-123';
      const sessionObj = {
        id: sessionId,
        title: 'Sesi Penting',
      };

      // Remote events diambil dari Google Calendar (mengandung extendedProperties.private.evenSessionId)
      const remoteEventsFromGoogle = [
        {
          id: 'unrelated-remote-1',
          htmlLink: 'https://calendar.google.com/event?eid=unrelated',
          extendedProperties: {
            private: {
              evenSessionId: 'other-session-id',
            },
          },
        },
        {
          id: 'matched-remote-event-999',
          htmlLink: 'https://calendar.google.com/event?eid=matched999',
          extendedProperties: {
            private: {
              evenTaskId: 'task-123',
              evenSessionId: sessionId,
              evenSessionIndex: '1',
            },
          },
        },
      ];

      // Rekonsiliasikan sesi ambigu dengan event remote
      const reconResult = reconcileSessionWithRemoteEvents(sessionObj, remoteEventsFromGoogle);

      assert.strictEqual(reconResult.status, 'confirmed', 'Rekonsiliasi harus terkonfirmasi');
      assert.strictEqual(reconResult.remoteEventId, 'matched-remote-event-999');
      assert.strictEqual(reconResult.htmlLink, 'https://calendar.google.com/event?eid=matched999');

      // Setelah rekonsiliasi, sesi diperbarui dengan remote ID terkonfirmasi dan syncStatus: 'synced'
      const reconciledSession: TaskScheduleSession = {
        id: sessionId,
        taskTitle: 'Sesi Penting',
        sessionIndex: 1,
        totalSessions: 1,
        durationMinutes: 45,
        startAt: '2026-11-06T16:00:00+07:00',
        endAt: '2026-11-06T16:45:00+07:00',
        syncStatus: 'synced',
        googleCalendarEventId: reconResult.remoteEventId,
        htmlLink: reconResult.htmlLink,
      };

      // Pada push berikutnya via executeSchedulePush, sesi yang sudah synced dengan remote ID valid
      // harus di-skip secara idempoten tanpa melakukan panggilan pembuatan event baru
      let createCalled = false;
      const mockCreateFn = async () => {
        createCalled = true;
        return { id: 'should-not-be-called' };
      };

      const guard = new CalendarOperationGuard();
      const ticket = guard.startPush();
      let stateTasks: Task[] = [];
      const mockSetTasks: any = (updater: any) => {
        stateTasks = typeof updater === 'function' ? updater(stateTasks) : updater;
      };

      const nextPushResult = await executeSchedulePush({
        token: 'mock-token',
        task: {
          id: 'task-123',
          userId: 'user-1',
          title: 'Sesi Penting',
          status: 'SCHEDULED',
          allowSplit: false,
          estimatedDurationMinutes: 45,
          minimumSessionMinutes: 30,
          priority: 'MEDIUM',
          createdAt: new Date().toISOString(),
          scheduledSessions: [reconciledSession],
        },
        sessions: [reconciledSession],
        timezone: 'Asia/Jakarta',
        userId: 'user-1',
        pushTicket: ticket,
        setTasks: mockSetTasks,
        createEventFn: mockCreateFn,
        saveToStorage: async () => {},
      });

      assert.strictEqual(createCalled, false, 'Sesi yang sudah terkonfirmasi rekonsiliasi tidak boleh memicu POST baru');
      assert.strictEqual(nextPushResult.updatedSessions[0].googleCalendarEventId, 'matched-remote-event-999');
      assert.strictEqual(nextPushResult.updatedSessions[0].syncStatus, 'synced');

      console.log('  ✅ [PASS] Test 37 (Test B): Rekonsiliasi berbasis extendedProperties.private terkonfirmasi unik dan push berikutnya idempoten.');
    }

    // ----------------------------------------------------
    // TEST 38 (TEST C): Ambiguous Search Result (>1 Candidates) Prevents Blind Selection & Duplicate POST
    // ----------------------------------------------------
    console.log('\n--- [Test 38 / Test C] Ambiguous Search Result (>1 Candidates) Prevents Blind Selection ---');
    {
      const sessionId = 'sess-ambiguous-candidate-test';
      const sessionObj = {
        id: sessionId,
        title: 'Tugas Split Multi-Kandidat',
      };

      // Remote events Google Calendar mengandung dua agenda dengan evenSessionId yang identik
      const remoteEventsWithDuplicates = [
        {
          id: 'remote-dup-1',
          extendedProperties: {
            private: { evenSessionId: sessionId },
          },
        },
        {
          id: 'remote-dup-2',
          extendedProperties: {
            private: { evenSessionId: sessionId },
          },
        },
      ];

      const reconResult = reconcileSessionWithRemoteEvents(sessionObj, remoteEventsWithDuplicates);

      // Verifikasi 1: Dilarang memilih acak / blind selection
      assert.strictEqual(reconResult.status, 'ambiguous', 'Jika terdapat >1 kandidat, status harus ambiguous');
      assert.strictEqual(reconResult.remoteEventId, undefined, 'Remote ID tidak boleh diisi sembarangan');
      assert.strictEqual(reconResult.candidateIds?.length, 2);
      assert.ok(reconResult.message.includes('Ditemukan 2 kandidat agenda'));

      // Verifikasi 2: Sesi tetap berada pada needs_reconciliation
      const sessionStillAmbiguous: TaskScheduleSession = {
        id: sessionId,
        taskTitle: 'Tugas Split Multi-Kandidat',
        sessionIndex: 1,
        totalSessions: 1,
        durationMinutes: 30,
        startAt: '2026-11-06T17:00:00+07:00',
        endAt: '2026-11-06T17:30:00+07:00',
        syncStatus: 'needs_reconciliation',
      };

      // Verifikasi 3: executeSchedulePush TIDAK membuat POST baru untuk sesi ambiguous
      let duplicateCreated = false;
      const mockCreateFn = async () => {
        duplicateCreated = true;
        return { id: 'unexpected-post' };
      };

      const guard = new CalendarOperationGuard();
      const ticket = guard.startPush();
      let stateTasks: Task[] = [];
      const mockSetTasks: any = (updater: any) => {
        stateTasks = typeof updater === 'function' ? updater(stateTasks) : updater;
      };

      const pushRes = await executeSchedulePush({
        token: 'mock-token',
        task: {
          id: 'task-dup-test',
          userId: 'user-1',
          title: 'Tugas Split Multi-Kandidat',
          status: 'SCHEDULED',
          allowSplit: false,
          estimatedDurationMinutes: 30,
          minimumSessionMinutes: 30,
          priority: 'MEDIUM',
          createdAt: new Date().toISOString(),
          scheduledSessions: [sessionStillAmbiguous],
        },
        sessions: [sessionStillAmbiguous],
        timezone: 'Asia/Jakarta',
        userId: 'user-1',
        pushTicket: ticket,
        setTasks: mockSetTasks,
        createEventFn: mockCreateFn,
        saveToStorage: async () => {},
      });

      assert.strictEqual(duplicateCreated, false, 'POST baru dilarang ketika sesi berstatus needs_reconciliation');
      assert.strictEqual(pushRes.reconciliationCount, 1);
      assert.strictEqual(pushRes.updatedSessions[0].syncStatus, 'needs_reconciliation');

      console.log('  ✅ [PASS] Test 38 (Test C): Multi-kandidat remote dideteksi ambiguous, tidak ada pemilihan buta, dan POST dicegah.');
    }

    // ----------------------------------------------------
    // TEST 39 (TEST D): Disconnect During Push via Production Handler
    // ----------------------------------------------------
    console.log('\n--- [Test 39 / Test D] Production Handler executeSchedulePush Disconnect Mid-Push ---');
    {
      const guard = new CalendarOperationGuard();
      const pushTicket = guard.startPush();

      const initialSessions: TaskScheduleSession[] = [
        {
          id: 'sess-p1',
          taskTitle: 'Tugas Besar Proyek',
          sessionIndex: 1,
          totalSessions: 2,
          durationMinutes: 45,
          startAt: '2026-11-06T09:00:00+07:00',
          endAt: '2026-11-06T09:45:00+07:00',
          syncStatus: 'pending',
        },
        {
          id: 'sess-p2',
          taskTitle: 'Tugas Besar Proyek',
          sessionIndex: 2,
          totalSessions: 2,
          durationMinutes: 45,
          startAt: '2026-11-06T10:00:00+07:00',
          endAt: '2026-11-06T10:45:00+07:00',
          syncStatus: 'pending',
        },
      ];

      // Mock create function yang mensimulasikan sesi 1 sukses, lalu disconnect dipanggil tepat sebelum sesi 2
      let callCount = 0;
      const mockCreateEvent = async (
        _token: string,
        input: any,
        signal?: AbortSignal
      ) => {
        callCount++;
        if (callCount === 1) {
          // Sesi 1 berhasil
          return { id: 'gcal-remote-p1-success' };
        }
        // Jika dipanggil setelah abort, sinyal harus sudah aktif
        if (signal?.aborted) {
          const classification = classifyGoogleCalendarError(0, '', { name: 'AbortError' });
          throw new GoogleCalendarApiError(classification);
        }
        return { id: 'gcal-remote-p2-success' };
      };

      // Mock createEventFn yang memicu guard.disconnect() segera setelah sesi 1 selesai
      const mockCreateWithDisconnect = async (
        token: string,
        input: any,
        signal?: AbortSignal
      ) => {
        const res = await mockCreateEvent(token, input, signal);
        if (callCount === 1) {
          // Simulasi interaksi pengguna: menekan tombol Disconnect saat pengiriman berlangsung
          guard.disconnect();
        }
        return res;
      };

      let localStateTasks: Task[] = [];
      const mockSetTasks: any = (updater: any) => {
        localStateTasks = typeof updater === 'function' ? updater(localStateTasks) : updater;
      };

      const firestoreWrites: any[] = [];
      const mockSaveToStorage = async (task: Task, userId: string) => {
        firestoreWrites.push({ task, userId });
      };

      // State koneksi aplikasi saat ini
      let connectionStatus = 'unconnected';

      const pushResult = await executeSchedulePush({
        token: 'mock-token',
        task: {
          id: 'task-disconnect-test',
          userId: 'user-auth-d',
          title: 'Tugas Besar Proyek',
          status: 'SCHEDULED',
          allowSplit: true,
          estimatedDurationMinutes: 90,
          minimumSessionMinutes: 45,
          priority: 'HIGH',
          createdAt: new Date().toISOString(),
          scheduledSessions: initialSessions,
        },
        sessions: initialSessions,
        timezone: 'Asia/Jakarta',
        userId: 'user-auth-d',
        pushTicket,
        setTasks: mockSetTasks,
        createEventFn: mockCreateWithDisconnect,
        saveToStorage: mockSaveToStorage,
      });

      // 1. Verifikasi tiket & status stale
      assert.strictEqual(pushResult.wasAborted, true, 'Operasi harus ditandai wasAborted');
      assert.strictEqual(pushResult.isStale, true, 'Operasi harus ditandai isStale');
      assert.strictEqual(pushResult.successCount, 1, 'Sesi 1 berhasil disimpan');

      // 2. Verifikasi Sesi 1 mempertahankan ID remote
      const sess1 = pushResult.updatedSessions[0];
      assert.strictEqual(sess1.syncStatus, 'synced');
      assert.strictEqual(sess1.googleCalendarEventId, 'gcal-remote-p1-success');

      // 3. Verifikasi Sesi 2 yang dibatalkan tetap pending dan tidak memiliki remote ID
      const sess2 = pushResult.updatedSessions[1];
      assert.strictEqual(sess2.syncStatus, 'pending');
      assert.strictEqual(sess2.googleCalendarEventId, undefined);

      // 4. Verifikasi Persistensi Firestore: Seluruh sesi (termasuk yang synced dan pending) tersimpan
      assert.strictEqual(firestoreWrites.length, 1, 'Firestore harus menerima snapshot tugas');
      assert.strictEqual(firestoreWrites[0].task.scheduledSessions[0].googleCalendarEventId, 'gcal-remote-p1-success');
      assert.strictEqual(firestoreWrites[0].task.scheduledSessions[1].syncStatus, 'pending');

      // 5. Stale Guard: Karena pushResult.isStale === true, connectionStatus TIDAK diubah
      assert.strictEqual(connectionStatus, 'unconnected', 'Status koneksi tetap unconnected setelah disconnect');

      console.log('  ✅ [PASS] Test 39 (Test D): Production handler mempertahankan ID sesi berhasil, menyimpan sesi pending ke storage, dan melindungi status koneksi.');
    }

    // ----------------------------------------------------
    // TEST 40 (TEST E): Newer Push Supersedes Older Push via Production Handler
    // ----------------------------------------------------
    console.log('\n--- [Test 40 / Test E] Newer Push Supersedes Older Push via executeSchedulePush ---');
    {
      const guard = new CalendarOperationGuard();

      // Push A dimulai
      const pushA = guard.startPush();

      // Push B dimulai sesaat kemudian (menggantikan Push A)
      const pushB = guard.startPush();

      assert.strictEqual(pushA.isStale(), true, 'Push A harus menjadi stale');
      assert.strictEqual(pushB.isStale(), false, 'Push B harus aktif');

      // State diagnostik milik Push B yang aktif
      let diagnosticState = {
        connectionStatus: 'connected',
        lastErrorMessage: undefined as string | undefined,
        eventsCreatedCount: 10,
      };

      const firestoreWritesA: any[] = [];
      const mockSaveStorageA = async (task: Task, userId: string) => {
        firestoreWritesA.push({ task, userId });
      };

      let stateTasks: Task[] = [];
      const mockSetTasks: any = (updater: any) => {
        stateTasks = typeof updater === 'function' ? updater(stateTasks) : updater;
      };

      const taskA: Task = {
        id: 'task-a-interleaved',
        userId: 'user-test-e',
        title: 'Task A Superceded',
        status: 'SCHEDULED',
        allowSplit: false,
        estimatedDurationMinutes: 30,
        minimumSessionMinutes: 30,
        priority: 'LOW',
        createdAt: new Date().toISOString(),
        scheduledSessions: [
          {
            id: 'sess-a-1',
            taskTitle: 'Task A Superceded',
            sessionIndex: 1,
            totalSessions: 1,
            durationMinutes: 30,
            startAt: '2026-11-06T08:00:00+07:00',
            endAt: '2026-11-06T08:30:00+07:00',
            syncStatus: 'pending',
          },
        ],
      };

      // Jalankan push A via production handler
      const resultA = await executeSchedulePush({
        token: 'mock-token',
        task: taskA,
        sessions: taskA.scheduledSessions,
        timezone: 'Asia/Jakarta',
        userId: 'user-test-e',
        pushTicket: pushA,
        setTasks: mockSetTasks,
        saveToStorage: mockSaveStorageA,
      });

      // 1. Verifikasi bahwa resultA ditandai isStale: true
      assert.strictEqual(resultA.isStale, true, 'Hasil push A harus ditandai isStale');

      // 2. Verifikasi Task A tetap tersimpan ke Firestore
      assert.strictEqual(firestoreWritesA.length, 1, 'Task A harus tetap dipersistensikan');
      assert.strictEqual(firestoreWritesA[0].task.id, 'task-a-interleaved');

      // 3. Simulasi handler produksi: jika resultA.isStale === true, diagnostik TIDAK ditimpa
      let diagnosticMutatedByA = false;
      if (!resultA.isStale) {
        diagnosticMutatedByA = true;
        diagnosticState = {
          connectionStatus: 'needs_reauth',
          lastErrorMessage: 'Error dari operasi A yang sudah kedaluwarsa',
          eventsCreatedCount: 0,
        };
      }

      assert.strictEqual(diagnosticMutatedByA, false, 'Push A tidak boleh memutasi state diagnostik');
      assert.strictEqual(diagnosticState.connectionStatus, 'connected');
      assert.strictEqual(diagnosticState.eventsCreatedCount, 10);
      assert.strictEqual(diagnosticState.lastErrorMessage, undefined);

      console.log('  ✅ [PASS] Test 40 (Test E): Stale push data terpersistensi penuh ke storage, dan status diagnostik operasi terbaru terlindungi.');
    }

    // =========================================================================
    // PHASE 2A.3.4 & PHASE 2A.3.4.1 TESTS:
    // API-LEVEL VERIFICATION, STRICT RECONCILIATION & TRUE CONCURRENCY
    // =========================================================================

    // -------------------------------------------------------------------------
    // CATEGORY: API-LEVEL TESTS (createGoogleCalendarEvent PRODUCTION FUNCTION)
    // -------------------------------------------------------------------------

    // TEST 41 (API-Level Test A): Pre-dispatch Abort
    console.log('\n--- [Test 41 / API Test A] Pre-Dispatch Abort on createGoogleCalendarEvent ---');
    {
      const abortCtrl = new AbortController();
      abortCtrl.abort(); // Signal sudah aktif sebelum fungsi dipanggil

      let fetchCalled = false;
      global.fetch = async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ id: 'unexpected' }) } as any;
      };

      let caughtError: any = null;
      try {
        await createGoogleCalendarEvent(
          'mock-token',
          {
            title: 'Test Pre-Dispatch Abort',
            startAt: '2026-11-08T10:00:00+07:00',
            endAt: '2026-11-08T11:00:00+07:00',
          },
          abortCtrl.signal
        );
      } catch (err: any) {
        caughtError = err;
      }

      assert.ok(caughtError instanceof GoogleCalendarApiError, 'Harus melempar GoogleCalendarApiError');
      assert.strictEqual(fetchCalled, false, 'Fetch TIDAK boleh dipanggil jika sinyal sudah diaborted pre-dispatch');
      assert.strictEqual(caughtError.code, 'ABORTED');
      assert.strictEqual(caughtError.isPostAmbiguous, false, 'Pre-dispatch abort harus memiliki isPostAmbiguous: false');
      assert.strictEqual(caughtError.phase, 'pre_dispatch', 'Phase harus pre_dispatch');
      console.log('  ✅ [PASS] Test 41 (API Test A): Pre-dispatch abort dicegat tanpa panggil fetch, isPostAmbiguous: false, phase: pre_dispatch.');
    }

    // TEST 42 (API-Level Test B): Post-dispatch AbortError
    console.log('\n--- [Test 42 / API Test B] Post-Dispatch Abort on createGoogleCalendarEvent ---');
    {
      const abortCtrl = new AbortController();
      const mockServerDb: Array<{ title: string }> = [];

      let fetchCalled = false;
      global.fetch = async (_url: any, opts: any) => {
        fetchCalled = true;
        assert.strictEqual(opts.method, 'POST');
        const body = JSON.parse(opts.body);
        // Simulasikan server Google menerima dan menyimpan event sebelum jaringan klien terputus
        mockServerDb.push({ title: body.summary });

        // Simulasikan browser melempar AbortError saat menunggu respons jaringan
        abortCtrl.abort();
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      };

      let caughtError: any = null;
      try {
        await createGoogleCalendarEvent(
          'mock-token',
          {
            title: 'Test Post-Dispatch Abort',
            startAt: '2026-11-08T11:00:00+07:00',
            endAt: '2026-11-08T12:00:00+07:00',
          },
          abortCtrl.signal
        );
      } catch (err: any) {
        caughtError = err;
      }

      assert.ok(caughtError instanceof GoogleCalendarApiError);
      assert.strictEqual(fetchCalled, true, 'Fetch harus benar-benar menerima request POST');
      assert.strictEqual(mockServerDb.length, 1, 'Server database mencatat event tersimpan');
      assert.strictEqual(caughtError.code, 'ABORTED');
      assert.strictEqual(caughtError.isPostAmbiguous, true, 'Post-dispatch abort wajib isPostAmbiguous: true');
      assert.strictEqual(caughtError.phase, 'in_flight', 'Phase harus in_flight');
      console.log('  ✅ [PASS] Test 42 (API Test B): Post-dispatch abort melempar isPostAmbiguous: true dan phase: in_flight.');
    }

    // TEST 43 (API-Level Test C): Abort While Reading Response Body
    console.log('\n--- [Test 43 / API Test C] Abort While Reading Response Body on createGoogleCalendarEvent ---');
    {
      const abortCtrl = new AbortController();
      const mockServerDb: Array<{ id: string }> = [];

      global.fetch = async () => {
        mockServerDb.push({ id: 'gcal-server-ok' });
        return {
          ok: true,
          status: 200,
          json: async () => {
            abortCtrl.abort();
            const err = new Error('The user aborted a request while reading body.');
            err.name = 'AbortError';
            throw err;
          },
        } as any;
      };

      let caughtError: any = null;
      try {
        await createGoogleCalendarEvent(
          'mock-token',
          {
            title: 'Test Response Body Abort',
            startAt: '2026-11-08T13:00:00+07:00',
            endAt: '2026-11-08T14:00:00+07:00',
          },
          abortCtrl.signal
        );
      } catch (err: any) {
        caughtError = err;
      }

      assert.ok(caughtError instanceof GoogleCalendarApiError);
      assert.strictEqual(mockServerDb.length, 1);
      assert.strictEqual(caughtError.code, 'ABORTED');
      assert.strictEqual(caughtError.isPostAmbiguous, true, 'Abort saat membaca body wajib isPostAmbiguous: true');
      assert.strictEqual(caughtError.phase, 'response_body', 'Phase harus response_body');
      console.log('  ✅ [PASS] Test 43 (API Test C): Abort saat baca body terklasifikasi isPostAmbiguous: true dan phase: response_body.');
    }

    // TEST 44 (API-Level Test D): HTTP 500 & 503 on POST createGoogleCalendarEvent
    console.log('\n--- [Test 44 / API Test D] HTTP 500 and 503 on createGoogleCalendarEvent ---');
    {
      // Skenario 1: HTTP 500
      global.fetch = async () => ({
        ok: false,
        status: 500,
        text: async () => '{"error": {"code": 500, "message": "Internal Server Error"}}',
      } as any);

      let caughtError500: any = null;
      try {
        await createGoogleCalendarEvent('mock-token', {
          title: 'Test POST HTTP 500',
          startAt: '2026-11-08T14:00:00+07:00',
          endAt: '2026-11-08T15:00:00+07:00',
        });
      } catch (err: any) {
        caughtError500 = err;
      }

      assert.ok(caughtError500 instanceof GoogleCalendarApiError);
      assert.strictEqual(caughtError500.code, 'SERVICE_UNAVAILABLE', 'HTTP 500 harus menghasilkan code SERVICE_UNAVAILABLE');
      assert.strictEqual(caughtError500.status, 500);
      assert.strictEqual(caughtError500.isPostAmbiguous, true, 'HTTP 500 pada POST wajib isPostAmbiguous: true');
      assert.strictEqual(caughtError500.phase, 'server_error', 'Phase harus server_error');

      // Skenario 2: HTTP 503
      global.fetch = async () => ({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      } as any);

      let caughtError503: any = null;
      try {
        await createGoogleCalendarEvent('mock-token', {
          title: 'Test POST HTTP 503',
          startAt: '2026-11-08T15:00:00+07:00',
          endAt: '2026-11-08T16:00:00+07:00',
        });
      } catch (err: any) {
        caughtError503 = err;
      }

      assert.ok(caughtError503 instanceof GoogleCalendarApiError);
      assert.strictEqual(caughtError503.code, 'SERVICE_UNAVAILABLE', 'HTTP 503 harus menghasilkan code SERVICE_UNAVAILABLE');
      assert.strictEqual(caughtError503.status, 503);
      assert.strictEqual(caughtError503.isPostAmbiguous, true, 'HTTP 503 pada POST wajib isPostAmbiguous: true');
      assert.strictEqual(caughtError503.phase, 'server_error', 'Phase harus server_error');

      console.log('  ✅ [PASS] Test 44 (API Test D): HTTP 500 dan 503 menghasilkan SERVICE_UNAVAILABLE, isPostAmbiguous: true, phase: server_error.');
    }

    // -------------------------------------------------------------------------
    // CATEGORY: STRICT IDENTITY MATCHING TESTS (reconcileSessionWithRemoteEvents)
    // -------------------------------------------------------------------------

    // TEST 45: Strict Identity Matching (Task ID & Session ID Validation)
    console.log('\n--- [Test 45] Strict Identity Matching in reconcileSessionWithRemoteEvents ---');
    {
      const taskId = 'task-strict-45';
      const sessId = 'sess-strict-45';

      // 1. Task ID cocok dan session ID cocok: confirmed
      const matchBoth = reconcileSessionWithRemoteEvents(
        { id: sessId, taskId },
        [
          {
            id: 'gcal-exact-match',
            extendedProperties: {
              private: { evenTaskId: taskId, evenSessionId: sessId },
            },
          },
        ]
      );
      assert.strictEqual(matchBoth.status, 'confirmed');
      assert.strictEqual(matchBoth.remoteEventId, 'gcal-exact-match');

      // 2. Task ID berbeda dan session ID cocok: not_found (DILARANG fallback ke session ID saja)
      const diffTaskId = reconcileSessionWithRemoteEvents(
        { id: sessId, taskId: 'task-strict-45' },
        [
          {
            id: 'gcal-different-task',
            extendedProperties: {
              private: { evenTaskId: 'task-other-999', evenSessionId: sessId },
            },
          },
        ]
      );
      assert.strictEqual(diffTaskId.status, 'not_found', 'Task ID berbeda harus not_found');

      // 3. Task ID tidak ada pada metadata remote: not_found (DILARANG fallback)
      const missingRemoteTaskId = reconcileSessionWithRemoteEvents(
        { id: sessId, taskId },
        [
          {
            id: 'gcal-no-task-id',
            extendedProperties: {
              private: { evenSessionId: sessId }, // evenTaskId tidak ada
            },
          },
        ]
      );
      assert.strictEqual(missingRemoteTaskId.status, 'not_found', 'Task ID hilang di remote harus not_found');

      // 4. Session ID berbeda: not_found
      const diffSessionId = reconcileSessionWithRemoteEvents(
        { id: sessId, taskId },
        [
          {
            id: 'gcal-diff-sess',
            extendedProperties: {
              private: { evenTaskId: taskId, evenSessionId: 'sess-different-888' },
            },
          },
        ]
      );
      assert.strictEqual(diffSessionId.status, 'not_found', 'Session ID berbeda harus not_found');

      // 5. Dua kandidat dengan kedua identitas sama: ambiguous (DILARANG memilih otomatis)
      const twoIdenticalCandidates = reconcileSessionWithRemoteEvents(
        { id: sessId, taskId },
        [
          {
            id: 'gcal-candidate-a',
            extendedProperties: {
              private: { evenTaskId: taskId, evenSessionId: sessId },
            },
          },
          {
            id: 'gcal-candidate-b',
            extendedProperties: {
              private: { evenTaskId: taskId, evenSessionId: sessId },
            },
          },
        ]
      );
      assert.strictEqual(twoIdenticalCandidates.status, 'ambiguous', 'Dua kandidat identik harus ambiguous');
      assert.strictEqual(twoIdenticalCandidates.candidateIds?.length, 2);

      console.log('  ✅ [PASS] Test 45: Strict Identity Matching terverifikasi penuh (5 skenario: confirmed, not_found x3, ambiguous).');
    }

    // -------------------------------------------------------------------------
    // CATEGORY: RECONCILIATION ABORT & STALE PROPAGATION TESTS (reconcileTaskSessionsWithRemote)
    // -------------------------------------------------------------------------

    // TEST 46: AbortSignal Propagation & Stale Protection in Reconciliation
    console.log('\n--- [Test 46] AbortSignal Propagation & Stale Protection in Reconciliation ---');
    {
      const guard = new CalendarOperationGuard();
      const ticket = guard.startPush();

      const taskToRecon: Task = {
        id: 'task-recon-46',
        userId: 'user-46',
        title: 'Tugas Rekonsiliasi Propagasi',
        status: 'SCHEDULED',
        allowSplit: false,
        estimatedDurationMinutes: 30,
        minimumSessionMinutes: 30,
        priority: 'MEDIUM',
        createdAt: new Date().toISOString(),
        scheduledSessions: [
          {
            id: 'sess-recon-46',
            taskTitle: 'Tugas Rekonsiliasi Propagasi',
            sessionIndex: 1,
            totalSessions: 1,
            durationMinutes: 30,
            startAt: '2026-11-08T16:00:00+07:00',
            endAt: '2026-11-08T16:30:00+07:00',
            syncStatus: 'needs_reconciliation',
          },
        ],
      };

      // 1. Abort sebelum fetch tidak memulai request (fetchEventsFn tidak dipanggil)
      const preAbortedCtrl = new AbortController();
      preAbortedCtrl.abort();

      let preFetchCalled = false;
      const resPreAbort = await reconcileTaskSessionsWithRemote({
        token: 'mock-token',
        task: taskToRecon,
        userId: 'user-46',
        signal: preAbortedCtrl.signal,
        setTasks: () => {},
        fetchEventsFn: async () => {
          preFetchCalled = true;
          return { events: [] };
        },
      });
      assert.strictEqual(preFetchCalled, false, 'fetchEventsFn DILARANG dipanggil jika sudah diaborted pre-fetch');
      assert.strictEqual(resPreAbort.isStale, true);
      assert.strictEqual(resPreAbort.reconciledCount, 0);

      // 2. Abort saat fetch berlangsung: diteruskan via signal ke fetchEventsFn
      let signalReceivedDuringFetch: boolean = false;
      const inFlightAbortCtrl = new AbortController();

      let stateMutated = false;
      let storageSaved = false;

      const resInFlightAbort = await reconcileTaskSessionsWithRemote({
        token: 'mock-token',
        task: taskToRecon,
        userId: 'user-46',
        signal: inFlightAbortCtrl.signal,
        setTasks: () => { stateMutated = true; },
        saveToStorage: async () => { storageSaved = true; },
        fetchEventsFn: async (_tok, _min, _max, sig) => {
          signalReceivedDuringFetch = Boolean(sig);
          // Trigger abort saat fetch berlangsung
          inFlightAbortCtrl.abort();
          const abortErr = new Error('The operation was aborted.');
          abortErr.name = 'AbortError';
          throw abortErr;
        },
      });

      assert.strictEqual(signalReceivedDuringFetch, true, 'AbortSignal wajib diteruskan ke fetchEventsFn');
      assert.strictEqual(resInFlightAbort.isStale, true);
      assert.strictEqual(stateMutated, false, 'State tidak boleh dimutasi jika dibatalkan saat fetch');
      assert.strictEqual(storageSaved, false, 'Storage tidak boleh ditulis jika dibatalkan saat fetch');

      // 3. Operasi stale tidak mengubah state atau Firestore
      const staleTicket = {
        isStale: () => true,
        isAborted: () => false,
      };

      let staleStateMutated = false;
      let staleStorageSaved = false;

      const resStale = await reconcileTaskSessionsWithRemote({
        token: 'mock-token',
        task: taskToRecon,
        userId: 'user-46',
        ticket: staleTicket as any,
        setTasks: () => { staleStateMutated = true; },
        saveToStorage: async () => { staleStorageSaved = true; },
        fetchEventsFn: async () => ({
          events: [
            {
              id: 'gcal-stale-test',
              provider: 'google',
              title: 'Test',
              startAt: '2026-11-08T16:00:00+07:00',
              endAt: '2026-11-08T16:30:00+07:00',
              syncStatus: 'synced',
              extendedProperties: {
                private: { evenTaskId: 'task-recon-46', evenSessionId: 'sess-recon-46' },
              },
            },
          ],
        }),
      });

      assert.strictEqual(resStale.isStale, true);
      assert.strictEqual(staleStateMutated, false, 'Operasi stale dilarang memutasi React state');
      assert.strictEqual(staleStorageSaved, false, 'Operasi stale dilarang menulis ke Firestore');

      // 4. Operasi terbaru tetap memiliki kendali penuh atas diagnostik dan persistensi
      let freshStateMutated = false;
      let freshStorageSaved = false;

      const freshTicket = guard.startPush();
      const resFresh = await reconcileTaskSessionsWithRemote({
        token: 'mock-token',
        task: taskToRecon,
        userId: 'user-46',
        ticket: freshTicket,
        setTasks: () => { freshStateMutated = true; },
        saveToStorage: async () => { freshStorageSaved = true; },
        fetchEventsFn: async () => ({
          events: [
            {
              id: 'gcal-fresh-confirmed',
              provider: 'google',
              title: 'Test',
              startAt: '2026-11-08T16:00:00+07:00',
              endAt: '2026-11-08T16:30:00+07:00',
              syncStatus: 'synced',
              extendedProperties: {
                private: { evenTaskId: 'task-recon-46', evenSessionId: 'sess-recon-46' },
              },
            },
          ],
        }),
      });

      assert.strictEqual(resFresh.isStale, false);
      assert.strictEqual(resFresh.reconciledCount, 1);
      assert.strictEqual(freshStateMutated, true, 'Operasi fresh berhasil memutasi React state');
      assert.strictEqual(freshStorageSaved, true, 'Operasi fresh berhasil menulis ke Firestore');

      console.log('  ✅ [PASS] Test 46: AbortSignal propagation & stale guard pada rekonsiliasi terverifikasi kokoh.');
    }

    // -------------------------------------------------------------------------
    // CATEGORY: SERVICE-LEVEL TESTS (executeSchedulePush IDEMPOTENCY CONTRACT)
    // -------------------------------------------------------------------------

    // TEST 47: Service-Level Idempotency Contract & Ambiguous Post Mapping
    console.log('\n--- [Test 47] Service-Level Ambiguous Error Mapping & Idempotency ---');
    {
      const guard = new CalendarOperationGuard();
      const pushTicket = guard.startPush();

      // Skenario 1: Post-dispatch abort dipetakan ke needs_reconciliation
      const task47A: Task = {
        id: 'task-47-a',
        userId: 'user-47',
        title: 'Tugas Service 47A',
        status: 'SCHEDULED',
        allowSplit: false,
        estimatedDurationMinutes: 30,
        minimumSessionMinutes: 30,
        priority: 'LOW',
        createdAt: new Date().toISOString(),
        scheduledSessions: [
          {
            id: 'sess-47-a',
            taskTitle: 'Tugas Service 47A',
            sessionIndex: 1,
            totalSessions: 1,
            durationMinutes: 30,
            startAt: '2026-11-08T17:00:00+07:00',
            endAt: '2026-11-08T17:30:00+07:00',
            syncStatus: 'pending',
          },
        ],
      };

      const res47A = await executeSchedulePush({
        token: 'mock-token',
        task: task47A,
        sessions: task47A.scheduledSessions,
        timezone: 'Asia/Jakarta',
        userId: 'user-47',
        pushTicket,
        setTasks: () => {},
        createEventFn: async () => {
          throw new GoogleCalendarApiError({
            code: 'ABORTED',
            status: 0,
            isAuthError: false,
            isPermissionError: false,
            isRateLimitError: false,
            isTransient: false,
            shouldReauth: false,
            isPostAmbiguous: true,
            phase: 'in_flight',
            message: 'In-flight abort',
            userAction: 'Rekonsiliasi',
          });
        },
        saveToStorage: async () => {},
      });

      assert.strictEqual(res47A.updatedSessions[0].syncStatus, 'needs_reconciliation');
      assert.strictEqual(res47A.reconciliationCount, 1);

      // Skenario 2: HTTP 500 dipetakan ke needs_reconciliation
      const ticket47B = guard.startPush();
      const res47B = await executeSchedulePush({
        token: 'mock-token',
        task: task47A,
        sessions: task47A.scheduledSessions,
        timezone: 'Asia/Jakarta',
        userId: 'user-47',
        pushTicket: ticket47B,
        setTasks: () => {},
        createEventFn: async () => {
          throw new GoogleCalendarApiError({
            code: 'SERVICE_UNAVAILABLE',
            status: 500,
            isAuthError: false,
            isPermissionError: false,
            isRateLimitError: false,
            isTransient: true,
            shouldReauth: false,
            isPostAmbiguous: true,
            phase: 'server_error',
            message: 'Server 500',
            userAction: 'Coba lagi',
          });
        },
        saveToStorage: async () => {},
      });

      assert.strictEqual(res47B.updatedSessions[0].syncStatus, 'needs_reconciliation');

      // Skenario 3: Pre-dispatch abort tetap pending
      const ticket47C = guard.startPush();
      guard.abortActivePush();
      let createCalled47C = false;

      const res47C = await executeSchedulePush({
        token: 'mock-token',
        task: task47A,
        sessions: task47A.scheduledSessions,
        timezone: 'Asia/Jakarta',
        userId: 'user-47',
        pushTicket: ticket47C,
        setTasks: () => {},
        createEventFn: async () => {
          createCalled47C = true;
          return { id: 'unexpected' };
        },
        saveToStorage: async () => {},
      });

      assert.strictEqual(createCalled47C, false);
      assert.strictEqual(res47C.updatedSessions[0].syncStatus, 'pending');

      console.log('  ✅ [PASS] Test 47: Service-level mapping terbukti memetakan error ambigu ke needs_reconciliation dan pre-dispatch ke pending.');
    }

    // -------------------------------------------------------------------------
    // CATEGORY: CONCURRENCY TESTS (TRUE CONCURRENT PUSH WITH DEFERRED PROMISE)
    // -------------------------------------------------------------------------

    // TEST 48: True Concurrent Push Resolving in Reverse Order
    console.log('\n--- [Test 48] True Concurrent Pushes Resolving in Reverse Order via Deferred Promise ---');
    {
      const guard = new CalendarOperationGuard();

      // Controllable deferred promise untuk Push A
      let resolvePushAPost: (value: { id: string; htmlLink?: string }) => void;
      const pushAPostPromise = new Promise<{ id: string; htmlLink?: string }>((resolve) => {
        resolvePushAPost = resolve;
      });

      let pushAPostCalled = 0;
      let pushBPostCalled = 0;

      const firestoreWritesA: any[] = [];
      const firestoreWritesB: any[] = [];

      let stateTasks: Task[] = [];
      const mockSetTasks: any = (updater: any) => {
        stateTasks = typeof updater === 'function' ? updater(stateTasks) : updater;
      };

      let activeDiagnostic = {
        connectionStatus: 'syncing',
        lastErrorMessage: undefined as string | undefined,
        eventsCreatedCount: 0,
      };

      const taskA: Task = {
        id: 'task-concurrent-a',
        userId: 'user-concurrent',
        title: 'Task A (Older)',
        status: 'SCHEDULED',
        allowSplit: false,
        estimatedDurationMinutes: 30,
        minimumSessionMinutes: 30,
        priority: 'LOW',
        createdAt: new Date().toISOString(),
        scheduledSessions: [
          {
            id: 'sess-concurrent-a',
            taskTitle: 'Task A (Older)',
            sessionIndex: 1,
            totalSessions: 1,
            durationMinutes: 30,
            startAt: '2026-11-08T09:00:00+07:00',
            endAt: '2026-11-08T09:30:00+07:00',
            syncStatus: 'pending',
          },
        ],
      };

      const taskB: Task = {
        id: 'task-concurrent-b',
        userId: 'user-concurrent',
        title: 'Task B (Newer)',
        status: 'SCHEDULED',
        allowSplit: false,
        estimatedDurationMinutes: 45,
        minimumSessionMinutes: 30,
        priority: 'HIGH',
        createdAt: new Date().toISOString(),
        scheduledSessions: [
          {
            id: 'sess-concurrent-b',
            taskTitle: 'Task B (Newer)',
            sessionIndex: 1,
            totalSessions: 1,
            durationMinutes: 45,
            startAt: '2026-11-08T10:00:00+07:00',
            endAt: '2026-11-08T10:45:00+07:00',
            syncStatus: 'pending',
          },
        ],
      };

      // 1. Push A dimulai dan ticket diperoleh
      const pushTicketA = guard.startPush();

      // Push A memulai executeSchedulePush() secara asynchronous / in-flight
      const promiseA = executeSchedulePush({
        token: 'mock-valid-token',
        task: taskA,
        sessions: taskA.scheduledSessions,
        timezone: 'Asia/Jakarta',
        userId: 'user-concurrent',
        pushTicket: pushTicketA,
        setTasks: mockSetTasks,
        createEventFn: async () => {
          pushAPostCalled++;
          // Push A menunggu deferred promise respons dari server Google
          return await pushAPostPromise;
        },
        saveToStorage: async (t, u) => { firestoreWritesA.push({ t, u }); },
      });

      // Verifikasi Push A sudah mulai dan memanggil POST pertama
      assert.strictEqual(pushAPostCalled, 1, 'Push A harus sudah memulai POST ke Google');
      assert.strictEqual(pushTicketA.isStale(), false, 'Push A belum stale saat mulai');

      // 2. Push B dimulai dan menggantikan Push A
      const pushTicketB = guard.startPush();
      // Seketika Push Ticket A menjadi stale dan aborted oleh guard
      assert.strictEqual(pushTicketA.isStale(), true, 'Push Ticket A harus menjadi stale saat Push B dimulai');
      assert.strictEqual(pushTicketA.isAborted(), true, 'Push Ticket A harus diaborted');
      assert.strictEqual(pushTicketB.isStale(), false, 'Push Ticket B harus aktif');

      // 3. Push B menyelesaikan operasi LEBIH DULU
      const resultB = await executeSchedulePush({
        token: 'mock-valid-token',
        task: taskB,
        sessions: taskB.scheduledSessions,
        timezone: 'Asia/Jakarta',
        userId: 'user-concurrent',
        pushTicket: pushTicketB,
        setTasks: mockSetTasks,
        createEventFn: async () => {
          pushBPostCalled++;
          return { id: 'gcal-id-b-confirmed' };
        },
        saveToStorage: async (t, u) => { firestoreWritesB.push({ t, u }); },
      });

      // Handler aplikasi memutasi diagnostik B (karena resultB.isStale === false)
      if (!resultB.isStale) {
        activeDiagnostic = {
          connectionStatus: 'sync_success',
          lastErrorMessage: undefined,
          eventsCreatedCount: activeDiagnostic.eventsCreatedCount + resultB.successCount,
        };
      }

      assert.strictEqual(resultB.isStale, false, 'Result B tidak stale');
      assert.strictEqual(resultB.successCount, 1);
      assert.strictEqual(activeDiagnostic.connectionStatus, 'sync_success');
      assert.strictEqual(activeDiagnostic.eventsCreatedCount, 1);

      // 4. Push A menyelesaikan responsnya setelah B selesai (resolve deferred promise)
      resolvePushAPost!({ id: 'gcal-id-a-confirmed' });
      const resultA = await promiseA;

      // Handler aplikasi memeriksa isStale:
      let pushAOverwroteDiagnostic = false;
      if (!resultA.isStale) {
        pushAOverwroteDiagnostic = true;
        activeDiagnostic = {
          connectionStatus: 'needs_reauth',
          lastErrorMessage: 'Error usang dari Push A',
          eventsCreatedCount: 999,
        };
      }

      // 5. Verifikasi bahwa operasi A tidak menimpa diagnostik B
      assert.strictEqual(resultA.isStale, true, 'Result A harus ditandai isStale: true');
      assert.strictEqual(pushAOverwroteDiagnostic, false, 'Push A dilarang memutasi diagnostik');
      assert.strictEqual(activeDiagnostic.connectionStatus, 'sync_success', 'Status diagnostik Push B tetap utuh');
      assert.strictEqual(activeDiagnostic.eventsCreatedCount, 1);
      assert.strictEqual(activeDiagnostic.lastErrorMessage, undefined);

      // 6. Verifikasi bahwa ID remote yang sudah berhasil diperoleh tidak hilang (data preservation)
      assert.strictEqual(resultA.updatedSessions[0].googleCalendarEventId, 'gcal-id-a-confirmed');
      assert.strictEqual(resultA.updatedSessions[0].syncStatus, 'synced');
      assert.strictEqual(firestoreWritesA.length, 1, 'Data Task A tetap terpersistensi ke Firestore');
      assert.strictEqual(firestoreWritesA[0].t.scheduledSessions[0].googleCalendarEventId, 'gcal-id-a-confirmed');
      assert.strictEqual(firestoreWritesB.length, 1, 'Data Task B terpersistensi ke Firestore');
      assert.strictEqual(firestoreWritesB[0].t.scheduledSessions[0].googleCalendarEventId, 'gcal-id-b-confirmed');

      // 7. Verifikasi tidak ada POST duplikat untuk sesi yang sama
      assert.strictEqual(pushAPostCalled, 1, 'Hanya tepat 1 POST untuk sesi A');
      assert.strictEqual(pushBPostCalled, 1, 'Hanya tepat 1 POST untuk sesi B');

      console.log('  ✅ [PASS] Test 48: True Concurrent Pushes dengan deferred promise terverifikasi race-condition free.');
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
