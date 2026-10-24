import {
  fetchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  sanitizeGoogleErrorMessage,
} from '../src/lib/googleCalendar';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASSED: ${message}`);
}

export async function runGoogleCalendarUnitTests() {
  console.log('=== RUNNING GOOGLE CALENDAR READ/WRITE & ERROR HANDLING TESTS ===\n');

  const originalFetch = global.fetch;

  try {
    // ----------------------------------------------------
    // TEST 1: GET Success with Events & Pagination
    // ----------------------------------------------------
    console.log('--- Test 1: GET Success with Events & Pagination ---');
    let callCount = 0;
    global.fetch = async (url: any) => {
      callCount++;
      const urlStr = String(url);
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'evt-1',
                summary: 'Rapat Perencanaan Produk',
                start: { dateTime: '2026-10-25T10:00:00+07:00' },
                end: { dateTime: '2026-10-25T11:00:00+07:00' },
                status: 'confirmed',
                htmlLink: 'https://calendar.google.com/event?eid=1',
              },
              {
                id: 'evt-cancelled',
                summary: 'Rapat Batal',
                start: { dateTime: '2026-10-25T11:00:00+07:00' },
                end: { dateTime: '2026-10-25T12:00:00+07:00' },
                status: 'cancelled', // Must be filtered out
              },
            ],
            nextPageToken: 'page-token-2',
          }),
        } as any;
      } else {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: 'evt-2',
                summary: 'Workshop Teknik',
                start: { date: '2026-10-26' }, // All day event
                end: { date: '2026-10-26' },
                status: 'confirmed',
              },
            ],
          }),
        } as any;
      }
    };

    const fetchResult = await fetchGoogleCalendarEvents('valid-mock-token');
    assert(fetchResult.events.length === 2, `Expected 2 non-cancelled events, got ${fetchResult.events.length}`);
    assert(fetchResult.events[0].title === 'Rapat Perencanaan Produk', 'Event 1 title matches');
    assert(fetchResult.events[0].htmlLink === 'https://calendar.google.com/event?eid=1', 'htmlLink is preserved');
    assert(fetchResult.events[1].isAllDay === true, 'Event 2 is recognized as all day');
    assert(callCount === 2, `Expected 2 paginated calls, got ${callCount}`);

    // ----------------------------------------------------
    // TEST 2: GET Empty Events (Empty list within range)
    // ----------------------------------------------------
    console.log('\n--- Test 2: GET Empty Events within range ---');
    global.fetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      } as any;
    };

    const emptyResult = await fetchGoogleCalendarEvents('valid-mock-token');
    assert(emptyResult.events.length === 0, 'Expected 0 events for empty list');
    assert(Boolean(emptyResult.rangeStart && emptyResult.rangeEnd), 'Must provide query date range');

    // ----------------------------------------------------
    // TEST 3: GET Fails with HTTP 401 Unauthorized (Expired / Invalid Token)
    // ----------------------------------------------------
    console.log('\n--- Test 3: GET Fails with HTTP 401 Unauthorized ---');
    global.fetch = async () => {
      return {
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'Invalid Credentials', code: 401 } }),
      } as any;
    };

    let caught401 = false;
    try {
      await fetchGoogleCalendarEvents('expired-token');
    } catch (err: any) {
      caught401 = true;
      assert(err.message.includes('401'), 'Error message must mention 401');
      assert(err.message.includes('kedaluwarsa') || err.message.includes('hubungkan'), 'Friendly guidance in Indonesian');
    }
    assert(caught401, 'Must throw error on 401');

    // ----------------------------------------------------
    // TEST 4: GET Fails with HTTP 403 Forbidden (Insufficient OAuth Scope)
    // ----------------------------------------------------
    console.log('\n--- Test 4: GET Fails with HTTP 403 Forbidden ---');
    global.fetch = async () => {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: 'Insufficient Permission', code: 403 } }),
      } as any;
    };

    let caught403 = false;
    try {
      await fetchGoogleCalendarEvents('no-scope-token');
    } catch (err: any) {
      caught403 = true;
      assert(err.message.includes('403'), 'Error message must mention 403');
      assert(err.message.includes('ditolak') || err.message.includes('izin'), 'Friendly permission denied guidance');
    }
    assert(caught403, 'Must throw error on 403');

    // ----------------------------------------------------
    // TEST 5: POST Success with Valid ID & htmlLink
    // ----------------------------------------------------
    console.log('\n--- Test 5: POST Success with Valid ID & htmlLink ---');
    global.fetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'real-google-event-id-9988',
          htmlLink: 'https://calendar.google.com/event?eid=real-9988',
        }),
      } as any;
    };

    const postSuccess = await createGoogleCalendarEvent('valid-token', {
      title: 'Tugas Belajar React',
      startAt: '2026-10-25T19:00:00+07:00',
      endAt: '2026-10-25T20:30:00+07:00',
      timezone: 'Asia/Jakarta',
    });

    assert(postSuccess.id === 'real-google-event-id-9988', 'Must return valid Google Event ID');
    assert(postSuccess.htmlLink === 'https://calendar.google.com/event?eid=real-9988', 'Must return htmlLink');

    // ----------------------------------------------------
    // TEST 6: POST Fails with Server Error (e.g. 500)
    // ----------------------------------------------------
    console.log('\n--- Test 6: POST Fails with Server Error 500 ---');
    global.fetch = async () => {
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as any;
    };

    let caughtPost500 = false;
    try {
      await createGoogleCalendarEvent('valid-token', {
        title: 'Tugas Gagal',
        startAt: '2026-10-25T19:00:00+07:00',
        endAt: '2026-10-25T20:00:00+07:00',
      });
    } catch (err: any) {
      caughtPost500 = true;
      assert(err.message.includes('Gagal menyimpan event'), 'Must throw clear failure');
    }
    assert(caughtPost500, 'Must catch 500 error on POST');

    // ----------------------------------------------------
    // TEST 7: POST 200 OK but Missing / Empty ID (Unconfirmed Operation)
    // ----------------------------------------------------
    console.log('\n--- Test 7: POST 200 OK but missing/empty ID must be treated as unconfirmed ---');
    global.fetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          // Missing or empty id
          id: '',
          summary: 'Missing ID Event',
        }),
      } as any;
    };

    let caughtUnconfirmed = false;
    try {
      await createGoogleCalendarEvent('valid-token', {
        title: 'Tugas ID Hilang',
        startAt: '2026-10-25T19:00:00+07:00',
        endAt: '2026-10-25T20:00:00+07:00',
      });
    } catch (err: any) {
      caughtUnconfirmed = true;
      assert(err.message.includes('tidak dapat dikonfirmasi'), 'Must explicitly throw unconfirmed result error');
    }
    assert(caughtUnconfirmed, 'Missing ID must NOT be marked as successful');

    // ----------------------------------------------------
    // TEST 8: DELETE Success & 404 Tolerant
    // ----------------------------------------------------
    console.log('\n--- Test 8: DELETE Success and 404 tolerance ---');
    global.fetch = async (_url: any, opts: any) => {
      if (opts?.method === 'DELETE') {
        return {
          ok: true,
          status: 204,
        } as any;
      }
      throw new Error('Unexpected call');
    };

    let deleteSuccess = true;
    try {
      await deleteGoogleCalendarEvent('valid-token', 'gcal-sample-id-123');
    } catch {
      deleteSuccess = false;
    }
    assert(deleteSuccess, 'DELETE 204 should succeed cleanly');

    // 404 Already Deleted:
    global.fetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' } as any);
    let delete404Success = true;
    try {
      await deleteGoogleCalendarEvent('valid-token', 'gcal-already-deleted');
    } catch {
      delete404Success = false;
    }
    assert(delete404Success, 'DELETE 404 must be tolerated as already deleted');

    // ----------------------------------------------------
    // TEST 9: Error Message Token Sanitization
    // ----------------------------------------------------
    console.log('\n--- Test 9: Token and PII Sanitization in Errors ---');
    const sensitiveError = 'Error with token ya29.a0AfH6SMB... and email private.user@company.com';
    const sanitized = sanitizeGoogleErrorMessage(500, sensitiveError);
    assert(!sanitized.includes('ya29.'), 'Must NOT leak ya29 token prefix');
    assert(!sanitized.includes('private.user@company.com'), 'Must NOT leak user email address');

    console.log('\n======================================================');
    console.log('🎉 ALL GOOGLE CALENDAR READ/WRITE TESTS PASSED! 🎉');
    console.log('======================================================\n');
  } finally {
    global.fetch = originalFetch;
  }
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('google-calendar')) {
  runGoogleCalendarUnitTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}
