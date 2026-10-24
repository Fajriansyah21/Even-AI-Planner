import {
  fetchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
} from '../src/lib/googleCalendar';

export async function runRealGoogleCalendarIntegrationTest(): Promise<{
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  reason: string;
  details?: Record<string, any>;
}> {
  console.log('\n=== REAL GOOGLE CALENDAR INTEGRATION TEST (OPT-IN) ===');

  const isOptIn = process.env.TEST_REAL_GOOGLE_CALENDAR === 'true';
  const testToken = process.env.GOOGLE_TEST_ACCESS_TOKEN;

  if (!isOptIn || !testToken) {
    const skipReason =
      'Pengujian integrasi Google Calendar nyata dilewati (SKIPPED): Memerlukan flag eksplisit TEST_REAL_GOOGLE_CALENDAR=true dan GOOGLE_TEST_ACCESS_TOKEN akun uji terisolasi demi keamanan akun pengguna.';
    console.log(`⚠️  ${skipReason}\n`);
    return {
      status: 'SKIPPED',
      reason: skipReason,
    };
  }

  console.log('🔒 Opt-in terdeteksi. Memulai pengujian live ke Google Calendar API...');

  const uniqueId = Date.now();
  const testTitle = `[EVEN TEST] Calendar Integration - ${uniqueId}`;
  const now = new Date();
  const startAt = new Date(now.getTime() + 3600000).toISOString(); // 1 hour from now
  const endAt = new Date(now.getTime() + 7200000).toISOString();   // 2 hours from now

  let createdEventId: string | null = null;

  try {
    // Step 1: Create live event
    console.log('1. Mengirim permintaan POST untuk membuat event uji unik...');
    const createRes = await createGoogleCalendarEvent(testToken, {
      title: testTitle,
      description: 'Event pengujian integrasi otomatis EVEN. Aman untuk dihapus.',
      startAt,
      endAt,
      timezone: 'Asia/Jakarta',
    });

    if (!createRes.id || !createRes.id.trim()) {
      throw new Error('Google Calendar tidak mengembalikan ID event yang valid.');
    }
    createdEventId = createRes.id;
    console.log(`   ✅ Event uji berhasil dibuat dengan ID: ${createdEventId}`);
    if (createRes.htmlLink) {
      console.log(`   🔗 HTML Link: ${createRes.htmlLink}`);
    }

    // Step 2: Read back events to verify presence
    console.log('2. Membaca ulang daftar agenda dari Google Calendar untuk memverifikasi...');
    const fetchMin = new Date(now.getTime() - 86400000);
    const fetchMax = new Date(now.getTime() + 86400000 * 2);
    const readResult = await fetchGoogleCalendarEvents(testToken, fetchMin, fetchMax);

    const foundEvent = readResult.events.find(
      (e) => e.id === `gcal-${createdEventId}` || e.title === testTitle
    );

    if (!foundEvent) {
      throw new Error(`Event uji "${testTitle}" tidak ditemukan saat pembacaan ulang.`);
    }
    console.log(`   ✅ Event uji ditemukan pada kalender: "${foundEvent.title}"`);

    // Step 3: Cleanup / Delete test event
    if (process.env.CLEANUP_TEST_EVENT !== 'false') {
      console.log('3. Membersihkan event uji (DELETE) dari Google Calendar...');
      await deleteGoogleCalendarEvent(testToken, createdEventId);
      console.log('   ✅ Event uji berhasil dihapus dari Google Calendar.');
    }

    console.log('🎉 PENGUJIAN INTEGRASI GOOGLE CALENDAR NYATA SELESAI DENGAN SUKSES!\n');
    return {
      status: 'PASS',
      reason: 'Pembuatan, pembacaan, dan penghapusan event live ke Google Calendar berhasil.',
      details: {
        eventId: createdEventId,
        title: testTitle,
        cleanedUp: process.env.CLEANUP_TEST_EVENT !== 'false',
      },
    };
  } catch (err: any) {
    console.error(`❌ Pengujian integrasi nyata gagal: ${err.message}`);
    // Attempt emergency cleanup if event was created
    if (createdEventId) {
      try {
        await deleteGoogleCalendarEvent(testToken, createdEventId);
      } catch {
        // ignore cleanup error
      }
    }
    return {
      status: 'FAIL',
      reason: `Gagal berinteraksi dengan live Google Calendar API: ${err.message}`,
    };
  }
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('real-google-integration')) {
  runRealGoogleCalendarIntegrationTest().catch((err) => {
    console.error('Test execution error:', err);
    process.exit(1);
  });
}
