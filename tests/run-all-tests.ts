process.env.TZ = 'Asia/Jakarta';

import { runGoogleCalendarUnitTests } from './google-calendar.test';
import { runNightAndTimezoneTests } from './night-and-timezone-scheduling.test';
import { runRealGoogleCalendarIntegrationTest } from './real-google-integration.test';
import { runCalendarVerticalPositionTests } from './calendar-vertical-position.test';
import { runActivityHistoryAndStatusTests } from './activity-history-and-status.test';

async function main() {
  console.log('================================================================');
  console.log('🚀 MENJALANKAN SELURUH PENGUJIAN OTOMATIS EVEN AI PLANNER 🚀');
  console.log('================================================================\n');

  try {
    // 1. Core Parser & Deterministic Scheduler Suite
    console.log('>>> [1/7] Parser & Scheduler Test Suite...');
    await import('./parser-scheduler.test');

    // 2. Night Scheduling & Asia/Jakarta Timezone Suite
    console.log('\n>>> [2/7] Night Scheduling & Timezone Suite...');
    await runNightAndTimezoneTests();

    // 3. Gemini Error Classification & Exponential Backoff Suite
    console.log('\n>>> [3/7] Gemini Error Handling & Resilience Suite...');
    await import('./gemini-error-handling.test');

    // 4. Auth Integrity & Zero Fake Login Suite
    console.log('\n>>> [4/7] Auth Integrity & Status Truth Suite...');
    await import('./auth-and-truth.test');

    // 5. Calendar Vertical Position & Scale Mapping Suite
    console.log('\n>>> [5/7] Calendar Vertical Position Mapping Suite...');
    runCalendarVerticalPositionTests();

    // 6. Activity History & Status Automation Suite
    console.log('\n>>> [6/7] Activity History & Automated Status Suite...');
    await runActivityHistoryAndStatusTests();

    // 7. Google Calendar Mock Read/Write Suite
    console.log('\n>>> [7/7] Google Calendar Mock API Suite...');
    await runGoogleCalendarUnitTests();

    // 8. Real Google Calendar Integration (Opt-in Check)
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
