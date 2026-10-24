process.env.TZ = 'Asia/Jakarta';

import { runGoogleCalendarUnitTests } from './google-calendar.test';
import { runNightAndTimezoneTests } from './night-and-timezone-scheduling.test';
import { runRealGoogleCalendarIntegrationTest } from './real-google-integration.test';

async function main() {
  console.log('================================================================');
  console.log('🚀 MENJALANKAN SELURUH PENGUJIAN OTOMATIS EVEN AI PLANNER 🚀');
  console.log('================================================================\n');

  try {
    // 1. Core Parser & Deterministic Scheduler Suite
    console.log('>>> [1/5] Parser & Scheduler Test Suite...');
    await import('./parser-scheduler.test');

    // 2. Night Scheduling & Asia/Jakarta Timezone Suite
    console.log('\n>>> [2/5] Night Scheduling & Timezone Suite...');
    await runNightAndTimezoneTests();

    // 3. Gemini Error Classification & Exponential Backoff Suite
    console.log('\n>>> [3/5] Gemini Error Handling & Resilience Suite...');
    await import('./gemini-error-handling.test');

    // 4. Auth Integrity & Zero Fake Login Suite
    console.log('\n>>> [4/5] Auth Integrity & Status Truth Suite...');
    await import('./auth-and-truth.test');

    // 5. Google Calendar Mock Read/Write Suite
    console.log('\n>>> [5/5] Google Calendar Mock API Suite...');
    await runGoogleCalendarUnitTests();

    // 6. Real Google Calendar Integration (Opt-in Check)
    console.log('\n>>> [Opsi] Pengujian Integrasi Google Calendar Nyata...');
    await runRealGoogleCalendarIntegrationTest();

    console.log('\n================================================================');
    console.log('✨ SEMUA SUITE PENGUJIAN OTOMATIS BERHASIL DILALUI DENGAN GEMILANG! ✨');
    console.log('================================================================\n');
  } catch (err: any) {
    console.error('\n❌ KESALAHAN PADA SUITE PENGUJIAN:', err.message || err);
    process.exit(1);
  }
}

main();
